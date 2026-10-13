import { existsSync, readFileSync } from "node:fs";

import { ProfilesConfig, type Profile } from "@ocd/core";
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
      .max(8)
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
      .object({ enabled: z.boolean().default(true).describe("Send macOS desktop notifications.") })
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
    allowFakeHarness: z
      .boolean()
      .default(false)
      .describe("Allow profiles that use the fake harness (tests and dry runs)."),
    log: z
      .object({ maxBytes: z.number().int().default(5_000_000), keep: z.number().int().default(3) })
      .strict()
      .prefault({}),
    profiles: ProfilesConfig.default({}).describe(
      "Named execution profiles. The key is the name used in dispatches and repo defaults. Reload with `ocd reload`.",
    ),
  })
  .strict();

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

/** The current profile set. Replaced atomically on reload; tasks keep their own snapshot. */
export class ProfileRegistry {
  private profiles = new Map<string, Profile>();

  constructor(profiles: Profile[] = []) {
    this.replace(profiles);
  }

  replace(profiles: Profile[]): void {
    this.profiles = new Map(profiles.map((p) => [p.name, p]));
  }

  get(name: string): Profile | null {
    return this.profiles.get(name) ?? null;
  }

  list(): Profile[] {
    return [...this.profiles.values()];
  }
}
