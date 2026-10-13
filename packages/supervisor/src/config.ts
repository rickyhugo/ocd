import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

export const SupervisorConfig = z.object({
  /** Maximum live workers. Serial by default. */
  concurrency: z.number().int().min(1).max(8).default(1),
  schedulerIntervalMs: z.number().int().min(10).default(1000),
  reconcileIntervalMs: z.number().int().min(100).default(30_000),
  /** A busy worker with no activity for this long gets an inspection request (never killed). */
  stallAfterMinutes: z.number().min(1).default(30),
  stallRealertMinutes: z.number().min(1).default(120),
  /** Interactive requests expire; expired approvals are refused, never replayed. */
  attentionExpiryMinutes: z.number().min(1).default(240),
  outbox: z
    .object({
      intervalMs: z.number().int().min(10).default(2000),
      maxAttempts: z.number().int().min(1).default(8),
      baseDelayMs: z.number().int().min(10).default(5000),
    })
    .prefault({}),
  notifications: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  opencode: z
    .object({
      enabled: z.boolean().default(true),
      /** Registration file written by the OpenCode service; defaults to the client's discovery path. */
      serviceFile: z.string().optional(),
    })
    .prefault({}),
  /** Allow profiles that use the fake harness (tests and dry runs). */
  allowFakeHarness: z.boolean().default(false),
  verifyTimeoutMs: z.number().int().min(1000).default(600_000),
  log: z
    .object({ maxBytes: z.number().int().default(5_000_000), keep: z.number().int().default(3) })
    .prefault({}),
});

export type SupervisorConfig = z.infer<typeof SupervisorConfig>;

export function loadConfig(
  path: string,
  overrides: Partial<z.input<typeof SupervisorConfig>> = {},
): SupervisorConfig {
  const fromFile: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return SupervisorConfig.parse({ ...(fromFile as object), ...overrides });
}
