import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { MANAGER_HOST, configurableHarnesses, findHarness, harnessNames } from "@ocd/adapters";
import {
  BranchSyncMode,
  MergeMethod,
  ProfilesConfig,
  ReposConfig,
  systemScheduler,
  type Profile,
  type Scheduler,
  type Timer,
} from "@ocd/core";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";

// ocd.jsonc: supervisor settings and execution profiles in one declarative,
// human-edited file. Unknown keys are errors so typos never pass silently.

/**
 * The ocd.jsonc section of every harness in the registry (`enabled`, plus the
 * options its descriptor declares). Typed loosely: read them with harnessSettings.
 */
function harnessSections(): Record<never, never> {
  return Object.fromEntries(
    configurableHarnesses().map((h) => [
      h.name,
      z
        .object({
          enabled: z
            .boolean()
            .default(h.config!.defaultEnabled)
            .describe(h.config!.enabledDescription),
          ...Object.fromEntries(
            h.config!.options.map((o) => [o.key, z.string().optional().describe(o.description)]),
          ),
        })
        .strict()
        .prefault({}),
    ]),
  );
}

const SupervisorConfigSchema = z
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
        enabled: z.boolean().default(true).describe("Send desktop notifications."),
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
            "Terminal app to bring forward when a notification is clicked: its bundle id (com.mitchellh.ghostty) or window class (kitty). Detected from tmux by default.",
          ),
      })
      .strict()
      .prefault({}),
    workerIdleMinutes: z
      .number()
      .min(1)
      .default(10)
      .describe(
        "Worker processes the supervisor owns stop after this long idle; their sessions resume on the next instruction.",
      ),
    // One section per harness, named after it: "claude": { "enabled": true }, ...
    ...harnessSections(),
    github: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Open and merge pull requests with the GitHub CLI (gh, logged in with `gh auth login`): ocd task pr / merge and the manager's PR tools. Off by default; when off, gh is never run. Restart to apply.",
          ),
      })
      .strict()
      .prefault({}),
    tmux: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Use tmux: a notification click (ocd focus) switches to the manager's tmux pane and raises its terminal, and a taken-over session opens in its own tmux window when the TUI runs in tmux. Off by default; when off, tmux is never run. `ocd focus` reads this on every call; the taken-over-session window needs a restart to apply.",
          ),
      })
      .strict()
      .prefault({}),
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
    branchSync: z
      .object({
        mode: BranchSyncMode.default("off").describe(
          "off: nothing runs. detect: read-only; tasks show how far their branch is behind the repo's baseRef and whether merging it would conflict. refresh: detect, and also fast-forward or merge the baseRef into clean, idle task branches at safe boundaries (never pushes, rebases, stashes or resolves conflicts). Per repo: repos.<name>.branchSync. Applies on save. See docs/branch-sync.md.",
        ),
        intervalMs: z
          .number()
          .int()
          .min(100)
          .default(300_000)
          .describe("How often task branches are compared with their base (restart to apply)."),
        maxTasksPerTick: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(25)
          .describe(
            "At most this many tasks are checked per interval, least recently checked first.",
          ),
      })
      .strict()
      .prefault({})
      .describe(
        "The branch-sync watchdog: keeps task branches near their repository's baseRef to reduce drift. Off by default.",
      ),
    selfUpdate: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "OCD updates itself: new commits on the repository's branch are built into ~/.ocd/install, smoke-tested, and switched to by restarting the background service once no worker that a restart would interrupt is running. Off by default. Restart to apply.",
          ),
        repo: z
          .string()
          .default("ocd")
          .describe(
            "The declared repository (under repos) that holds OCD's own source. Ignored when path is set.",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A checkout of OCD's own repository to follow instead of a declared repo (`~` is expanded), so a machine that only uses OCD need not dispatch work to it. `ocd setup` sets it.",
          ),
        branch: z
          .string()
          .optional()
          .describe("Branch to follow on origin; defaults to the remote's default branch."),
        intervalMinutes: z
          .number()
          .min(1)
          .default(10)
          .describe(
            "How often origin is checked for a new version (also right after a task lands in that repository).",
          ),
        build: z
          .array(z.string().min(1))
          .default(["pnpm install --frozen-lockfile", "pnpm run build"])
          .describe(
            "Shell commands that build a checkout, run in order in the new build directory.",
          ),
      })
      .strict()
      .prefault({})
      .describe("Keeping OCD itself up to date from its own repository."),
    autoCleanup: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Remove the worktrees of finished (accepted or cancelled) tasks after afterHours, the way `ocd task cleanup` does: never forced, so a worktree whose work would be lost is kept. Off by default.",
          ),
        afterHours: z
          .number()
          .min(1)
          .default(72)
          .describe("How long a finished task's worktree is kept before automatic cleanup."),
      })
      .strict()
      .prefault({}),
    usageLimits: z
      .object({
        notifyAt: z
          .array(z.number().min(1).max(100))
          .default([80, 95])
          .describe(
            "Percentages of a subscription usage window (5-hour, weekly, ...) that send a notification, once per window. [] turns these notifications off; reaching a limit is always reported.",
          ),
        pollMinutes: z
          .number()
          .min(0)
          .default(15)
          .describe(
            "How often limits are read, for the harnesses that can be read without a model call (no tokens). 0 reads them only from running workers; other harnesses report them only while a worker runs.",
          ),
      })
      .strict()
      .prefault({})
      .describe("Tracking the subscription usage limits the harnesses report. Restart to apply."),
    mergeMethod: MergeMethod.default("squash").describe(
      "How work lands in its base branch, through a pull request or a direct push: squash (one commit), merge (a merge commit) or rebase (the task's commits replayed). Per repo: repos.<name>.mergeMethod. Applies on save.",
    ),
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
            `Working directory of the manager. ${MANAGER_HOST.label} sessions started here may use the ocd_* tools; \`~\` is expanded.`,
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
    for (const [name, profile] of Object.entries(config.profiles)) {
      const harness = findHarness(profile.harness);
      if (!harness) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "harness"],
          message: `Unknown harness "${profile.harness}"; known: ${harnessNames().join(", ")}`,
        });
        continue;
      }
      const format = harness.models.format;
      if (format && !format.pattern.test(profile.model)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "model"],
          message: format.message,
        });
      }
    }
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

/**
 * Harness sections are keyed by harness name. A loaded config does not type
 * them (read them with `harnessSettings`), so a misspelled setting is still a
 * type error; the input accepts any section, which the schema then checks.
 */
type HarnessSectionsInput = { [harness: string]: unknown };
export const SupervisorConfig: z.ZodType<
  z.output<typeof SupervisorConfigSchema>,
  z.input<typeof SupervisorConfigSchema> & HarnessSectionsInput
> = SupervisorConfigSchema;
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;
export type SupervisorConfigInput = z.input<typeof SupervisorConfigSchema> & HarnessSectionsInput;

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
  private mergeMethods = new Map<string, MergeMethod>();
  private mergeMethodDefault: MergeMethod = "squash";
  private branchSyncDefault: BranchSyncMode = "off";
  private branchSyncModes = new Map<string, BranchSyncMode>();

  constructor(config: SupervisorConfig) {
    this.apply(config);
  }

  apply(config: SupervisorConfig): void {
    this.profiles = new Map(toProfiles(config).map((p) => [p.name, p]));
    this.managerDirectory = config.manager ? normalizeDirectory(config.manager.directory) : null;
    this.mergeMethodDefault = config.mergeMethod;
    this.mergeMethods = new Map(
      Object.entries(config.repos).flatMap(([name, repo]) =>
        repo.mergeMethod ? [[name, repo.mergeMethod] as const] : [],
      ),
    );
    this.branchSyncDefault = config.branchSync.mode;
    this.branchSyncModes = new Map(
      Object.entries(config.repos).flatMap(([name, repo]) =>
        repo.branchSync ? [[name, repo.branchSync] as const] : [],
      ),
    );
  }

  /** The repository's branch-sync mode; repos no longer declared are off. */
  branchSyncMode(repo: string, declared: boolean): BranchSyncMode {
    if (!declared) return "off";
    return this.branchSyncModes.get(repo) ?? this.branchSyncDefault;
  }

  /** The repository's mergeMethod, else the top-level one (squash by default). */
  mergeMethod(repo: string): MergeMethod {
    return this.mergeMethods.get(repo) ?? this.mergeMethodDefault;
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
  private timer: Timer | null = null;
  private poll: Timer | null = null;
  private readonly pollMs: number;
  private readonly scheduler: Scheduler;
  private fingerprint: string;

  constructor(
    path: string,
    onChange: () => void,
    options: { debounceMs?: number; pollMs?: number; scheduler?: Scheduler } = {},
  ) {
    this.path = path;
    this.onChange = onChange;
    this.debounceMs = options.debounceMs ?? 150;
    this.pollMs = options.pollMs ?? 2000;
    this.scheduler = options.scheduler ?? systemScheduler;
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
    this.poll = this.scheduler.setInterval(() => {
      if (this.stat() !== this.fingerprint) this.schedule();
    }, this.pollMs);
    this.poll.unref();
  }

  private schedule(): void {
    this.fingerprint = this.stat();
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    if (this.timer) this.scheduler.clearTimeout(this.timer);
    if (this.poll) this.scheduler.clearInterval(this.poll);
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }
}
