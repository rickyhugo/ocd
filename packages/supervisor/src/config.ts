import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { ProfilesConfig, ReposConfig, type Profile } from "@ocd/core";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

// ocd.jsonc: supervisor settings and execution profiles in one declarative,
// human-edited file. Unknown keys are errors so typos never pass silently.

export const SupervisorConfig = z
  .object({
    $schema: z.string().optional().describe("JSON Schema reference for editors."),
    concurrency: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Maximum number of live workers. Serial by default."),
    schedulerIntervalMs: z
      .number()
      .int()
      .min(10)
      .default(1000)
      .describe("How often queued work is admitted."),
    reconcileIntervalMs: z
      .number()
      .int()
      .min(100)
      .default(30_000)
      .describe("How often live workers are reconciled against the harnesses."),
    stallAfterMinutes: z
      .number()
      .min(1)
      .default(30)
      .describe(
        "A busy worker with no activity for this long gets an inspection request. Workers are never killed.",
      ),
    stallRealertMinutes: z
      .number()
      .min(1)
      .default(120)
      .describe("At most one stall alert per task per window."),
    attentionExpiryMinutes: z
      .number()
      .min(1)
      .default(240)
      .describe(
        "Unanswered permission requests and questions expire and are denied; they are never replayed.",
      ),
    outbox: z
      .object({
        intervalMs: z.number().int().min(10).default(2000),
        maxAttempts: z.number().int().min(1).default(8),
        baseDelayMs: z.number().int().min(10).default(5000),
      })
      .strict()
      .prefault({}),
    notifications: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe("Send desktop notifications (macOS and Linux)."),
        digestWindowMs: z
          .number()
          .int()
          .min(0)
          .default(3000)
          .describe(
            'Notifications raised within this many milliseconds of the first one are sent as one digest ("4 ready for review, 1 needs you"). 0 sends on the next outbox pass without waiting.',
          ),
        focusApp: z
          .string()
          .optional()
          .describe(
            "Terminal app to bring forward when a notification is clicked: a macOS bundle id (com.mitchellh.ghostty) or a Linux window class (kitty). Detected from tmux by default.",
          ),
      })
      .strict()
      .prefault({}),
    opencode: z
      .object({
        enabled: z.boolean().default(true),
        serviceFile: z
          .string()
          .optional()
          .describe(
            "OpenCode service registration file; defaults to OpenCode's own discovery path.",
          ),
      })
      .strict()
      .prefault({}),
    workerIdleMinutes: z
      .number()
      .min(1)
      .default(10)
      .describe(
        "Claude Code and Codex worker processes stop after this long idle; their sessions resume on the next instruction.",
      ),
    claude: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe("Offer Claude Code workers (profiles with harness claude)."),
        binary: z
          .string()
          .optional()
          .describe(
            "Absolute path of the claude binary; defaults to a PATH / ~/.local/bin lookup.",
          ),
      })
      .strict()
      .prefault({}),
    codex: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe("Offer Codex workers (profiles with harness codex)."),
        binary: z
          .string()
          .optional()
          .describe("Absolute path of the codex binary; defaults to a PATH / ~/.local/bin lookup."),
      })
      .strict()
      .prefault({}),
    gh: z
      .object({
        binary: z
          .string()
          .regex(/^(?:\/|~\/)/, "must be an absolute path (or start with ~/)")
          .optional()
          .describe(
            "Absolute path of the GitHub CLI used for pull requests (e.g. the output of `command -v gh` or `mise which gh`). Defaults to a PATH / ~/.local/bin lookup in the supervisor's own environment, which for a background service is not your shell's PATH. Saved changes apply without a restart.",
          ),
      })
      .strict()
      .prefault({})
      .describe("GitHub CLI (gh) used to open, inspect and merge task pull requests."),
    allowFakeHarness: z
      .boolean()
      .default(false)
      .describe("Allow profiles that use the fake harness (tests and dry runs)."),
    backups: z
      .object({
        intervalHours: z
          .number()
          .min(0)
          .default(24)
          .describe("Hours between automatic database backups; 0 disables them."),
        keep: z
          .number()
          .int()
          .min(1)
          .default(7)
          .describe("Number of automatic backups to keep in ~/.ocd/backups."),
      })
      .strict()
      .prefault({}),
    log: z
      .object({ maxBytes: z.number().int().default(5_000_000), keep: z.number().int().default(3) })
      .strict()
      .prefault({}),
    manager: z
      .object({
        directory: z
          .string()
          .min(1)
          .describe(
            "Working directory of the manager. OpenCode sessions started here may use the ocd_* tools; `~` is expanded.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "The manager: sessions in this directory act as manager, and the most recently used one receives updates.",
      ),
    repos: ReposConfig.default({}).describe(
      "Repositories the manager may dispatch to. The key is the repository name. Saved changes apply automatically.",
    ),
    profiles: ProfilesConfig.default({}).describe(
      "Named execution profiles. The key is the name used in dispatches and repo defaults. Saved changes apply automatically.",
    ),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [name, repo] of Object.entries(config.repos)) {
      if (repo.profile && !(repo.profile in config.profiles)) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", name, "profile"],
          message: `Profile "${repo.profile}" is not declared under profiles`,
        });
      }
    }
  });

export type SupervisorConfig = z.infer<typeof SupervisorConfig>;
export type SupervisorConfigInput = z.input<typeof SupervisorConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readConfigFile(path: string): unknown {
  if (!existsSync(path)) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new ConfigError(`${path} is not valid JSONC: ${details}`);
  }
  return value ?? {};
}

/** Reads and validates ocd.jsonc. Overrides (tests, CLI flags) win over the file. */
export function loadConfig(
  path: string,
  overrides: Partial<SupervisorConfigInput> = {},
): SupervisorConfig {
  const fromFile = readConfigFile(path);
  if (typeof fromFile !== "object" || fromFile === null || Array.isArray(fromFile)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const fileProfiles = (fromFile as { profiles?: Record<string, unknown> }).profiles;
  const parsed = SupervisorConfig.safeParse({
    ...fromFile,
    ...overrides,
    // Override profiles are added to the file's, never a replacement for them.
    profiles: { ...fileProfiles, ...overrides.profiles },
    repos: { ...(fromFile as { repos?: Record<string, unknown> }).repos, ...overrides.repos },
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config in ${path}:\n${issues}`);
  }
  return parsed.data;
}

export function toProfiles(config: Pick<SupervisorConfig, "profiles">): Profile[] {
  return Object.entries(config.profiles)
    .map(([name, p]) => ({
      name,
      harness: p.harness,
      model: p.model,
      description: p.description ?? null,
      agent: p.agent ?? null,
      instructions: p.instructions ?? null,
      permissionPolicy: p.permissionPolicy,
      envAllowlist: p.envAllowlist,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Expands `~` and resolves symlinks so directory comparisons are exact. */
export function normalizeDirectory(directory: string): string {
  const expanded =
    directory === "~" || directory.startsWith("~/")
      ? join(homedir(), directory.slice(1))
      : directory;
  const absolute = resolve(expanded);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

/** The parts of ocd.jsonc that apply live. Replaced atomically on save; tasks keep their own profile snapshot. */
export class LiveConfig {
  private profiles = new Map<string, Profile>();
  managerDirectory: string | null = null;
  /** gh.binary with `~` expanded; null means a PATH lookup. */
  ghBinary: string | null = null;
  private mergeMethods = new Map<string, "squash" | "merge" | "rebase">();

  constructor(config: SupervisorConfig) {
    this.apply(config);
  }

  apply(config: SupervisorConfig): void {
    this.profiles = new Map(toProfiles(config).map((p) => [p.name, p]));
    this.managerDirectory = config.manager ? normalizeDirectory(config.manager.directory) : null;
    this.ghBinary = config.gh.binary ? expandHome(config.gh.binary) : null;
    this.mergeMethods = new Map(
      Object.entries(config.repos).flatMap(([name, repo]) =>
        repo.mergeMethod ? [[name, repo.mergeMethod] as const] : [],
      ),
    );
  }

  mergeMethod(repo: string): "squash" | "merge" | "rebase" {
    return this.mergeMethods.get(repo) ?? "squash";
  }

  getProfile(name: string): Profile | null {
    return this.profiles.get(name) ?? null;
  }

  listProfiles(): Profile[] {
    return [...this.profiles.values()];
  }
}

/**
 * Watches ocd.jsonc for saves. Editors often replace the file (write + rename)
 * and the path may be a symlink, so the directories of both the link and its
 * target are watched and changes are debounced. File events can be delayed or
 * dropped, so a slow stat poll backs them up.
 */
export class ConfigWatcher {
  private readonly path: string;
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private poll: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private fingerprint: string;

  constructor(
    path: string,
    onChange: () => void,
    options: { debounceMs?: number; pollMs?: number } = {},
  ) {
    this.path = path;
    this.onChange = onChange;
    this.debounceMs = options.debounceMs ?? 150;
    this.pollMs = options.pollMs ?? 2000;
    this.fingerprint = this.stat();
  }

  /** Identity of the current file content; follows symlinks. */
  private stat(): string {
    try {
      const s = statSync(this.path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  start(): void {
    const targets = new Map<string, string>([[dirname(this.path), basename(this.path)]]);
    try {
      const real = realpathSync(this.path);
      targets.set(dirname(real), basename(real));
    } catch {
      // The file does not exist yet; its directory is still watched.
    }
    for (const [dir, name] of targets) {
      if (!existsSync(dir)) continue;
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === name) this.schedule();
      });
      watcher.on("error", () => undefined);
      this.watchers.push(watcher);
    }
    this.poll = setInterval(() => {
      if (this.stat() !== this.fingerprint) this.schedule();
    }, this.pollMs);
    this.poll.unref();
  }

  private schedule(): void {
    this.fingerprint = this.stat();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }
}
