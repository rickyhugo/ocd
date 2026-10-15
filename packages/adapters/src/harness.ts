import type { AdapterStatus, HarnessName } from "@ocd/core";

import type { HarnessAdapter } from "./types.ts";

// What OCD needs to know about a harness besides driving it: its name, how to
// build and check it, which models it accepts, and what `ocd setup` and
// `ocd doctor` may ask of it. One descriptor per harness, living next to the
// adapter and listed in registry.ts; nothing outside this package names a
// harness.

/** One section of ocd.jsonc, e.g. `"claude": { "enabled": true, "binary": "/opt/claude" }`. */
export interface HarnessSettings {
  enabled: boolean;
  /** The harness's own string options (`binary`, `serviceFile`, ...), as declared in `config.options`. */
  [option: string]: string | boolean | undefined;
}

/** What `create` gets from the supervisor / CLI. */
export interface HarnessContext {
  settings: HarnessSettings;
  /** Process-owned workers stop after this long idle. */
  idleStopMs: number;
  /** Resolves a binary on the PATH the login shell sets up (the configured path wins). */
  findBinary: (name: string, configured?: string) => string;
  onError?: (error: unknown, context: string) => void;
}

/** A model name as a harness lists it. */
export interface ListedModel {
  name: string;
  /** Accepted but not offered in pickers (e.g. Codex's hidden models). */
  hidden?: boolean;
}

export interface HarnessDescriptor {
  /** The value of `harness` in a profile, and the ocd.jsonc section name. */
  name: HarnessName;
  /** For people: "Claude Code". */
  label: string;
  /** Executable looked up on the PATH, for `ocd setup` and the model listing. */
  binary: string;
  /**
   * The ocd.jsonc section for this harness, or null when it has none (fake: a
   * test harness switched on by `allowFakeHarness`).
   */
  config: {
    /** Harnesses that run a vendor's CLI are opt-in (false). */
    defaultEnabled: boolean;
    /** Documents `enabled` in the JSON schema. */
    enabledDescription: string;
    /** Optional string settings next to `enabled`. */
    options: { key: string; description: string }[];
  } | null;
  /** Sessions live in an external service and survive a supervisor restart. */
  sessionsSurviveSupervisor: boolean;
  /**
   * How usage limits reach OCD: "reported" with a worker's turns, "readable"
   * also without a model call (the adapter implements readLimits).
   */
  usageLimits?: "reported" | "readable";
  /** The profile name `ocd setup` suggests: "oc", "cc", "codex". */
  profileName: string;
  create(ctx: HarnessContext): HarnessAdapter;
  /** Changes what `ocd doctor` shows for this harness's probe (e.g. adds a service check). */
  decorateProbe?(status: AdapterStatus): AdapterStatus;
  /** A read-only command that succeeds when the harness is logged in, as `ocd setup` checks it. */
  login?: { args: string[]; hint: string };
  models: {
    /** Required spelling of a profile's model, e.g. OpenCode's `provider/model`. */
    format?: { pattern: RegExp; message: string; hint?: string };
    /** A read-only command (arguments after the binary) that lists the models, spending no tokens. */
    list?: { args: string[]; parse(stdout: string): ListedModel[] };
    /** Names accepted without being listed (Claude Code's aliases); setup offers them when nothing is listed. */
    aliases?: string[];
    /** The listed model setup proposes first; the first one by default. */
    preferred?: RegExp;
  };
}

export type ModelCheck = "ok" | "unknown" | "unchecked";

/** A model without the `#variant` suffix some harnesses accept. */
export function baseModel(model: string): string {
  const at = model.indexOf("#");
  return at < 0 ? model : model.slice(0, at);
}

/**
 * Whether a profile's model is one the harness knows. `listed` is the
 * harness's own list (null when it has no list command or the command failed).
 * "unchecked": nothing to check against. Callers warn on "unknown"; lists lag
 * releases, so it is never an error.
 */
export function checkModel(
  models: HarnessDescriptor["models"],
  model: string,
  listed: ListedModel[] | null,
): ModelCheck {
  const name = baseModel(model);
  if (models.aliases?.includes(name)) return "ok";
  if (listed) return listed.some((m) => m.name === name) ? "ok" : "unknown";
  return "unchecked";
}

/** The models a picker offers: listed ones that are not hidden, else the aliases. */
export function pickableModels(
  models: HarnessDescriptor["models"],
  listed: ListedModel[] | null,
): string[] {
  const shown = (listed ?? [])
    .filter((m) => !m.hidden && (!models.format || models.format.pattern.test(m.name)))
    .map((m) => m.name);
  return shown.length ? shown : (models.aliases ?? []);
}

/** The picker's default: the preferred model when offered, else the first. */
export function defaultModel(models: HarnessDescriptor["models"], options: string[]): string {
  return options.find((m) => models.preferred?.test(m)) ?? options[0] ?? "";
}
