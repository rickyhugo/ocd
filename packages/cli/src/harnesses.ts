import { execFile } from "node:child_process";

import {
  HARNESSES,
  MANAGER_HOST,
  buildHarnessAdapters,
  checkModel,
  configurableHarnesses,
  harnessSettings,
  type HarnessAdapter,
  type HarnessDescriptor,
  type ListedModel,
  type ModelCheck,
} from "@ocd/adapters";
import type { AdapterStatus } from "@ocd/core";
import type { Logger, ManagerChannel, SupervisorConfig } from "@ocd/supervisor";

import { findBinary } from "./platform/index.ts";

export function buildAdapters({
  config,
  logger,
}: {
  config: SupervisorConfig;
  logger: Logger;
}): HarnessAdapter[] {
  return buildHarnessAdapters(config, {
    idleStopMs: config.workerIdleMinutes * 60_000,
    findBinary,
    onError: (harness, error, context) =>
      logger.warn({ err: error, context }, `${harness} adapter error`),
  });
}

/** Wake-ups for the registered manager go through the manager host's adapter. */
export function buildManagerChannel(adapters: HarnessAdapter[]): ManagerChannel | null {
  return MANAGER_HOST.channel(adapters);
}

/**
 * Read-only checks of the enabled harnesses: binary versions, logins, and
 * whatever service they need. Never starts workers or spends tokens.
 */
export async function probeHarnesses(config: SupervisorConfig): Promise<AdapterStatus[]> {
  const statuses: AdapterStatus[] = [];
  for (const harness of configurableHarnesses()) {
    const settings = harnessSettings(config, harness);
    if (!settings.enabled) continue;
    const status = await harness.create({ settings, idleStopMs: 0, findBinary }).probe();
    statuses.push(harness.decorateProbe ? harness.decorateProbe(status) : status);
  }
  return statuses;
}

/** How long a harness gets to list its models. */
const LIST_TIMEOUT_MS = 20_000;

/** Runs a read-only listing command; null when it failed or timed out. */
export type RunList = (binary: string, args: string[]) => Promise<string | null>;

const runList: RunList = (binary, args) =>
  new Promise((resolve) =>
    execFile(
      binary,
      args,
      { timeout: LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    ),
  );

export interface ModelReport {
  profile: string;
  harness: string;
  model: string;
  status: ModelCheck;
  /** Why the model could not be checked, when that is not simply "no list command". */
  note?: string;
}

/**
 * Checks every profile's model against its harness's own model list (the
 * read-only listing command, no tokens), skipping harnesses that are off.
 * Harnesses without a list command check aliases only.
 */
export async function checkProfileModels(
  config: SupervisorConfig,
  list: RunList = runList,
): Promise<ModelReport[]> {
  const reports: ModelReport[] = [];
  for (const harness of HARNESSES) {
    const profiles = Object.entries(config.profiles).filter(([, p]) => p.harness === harness.name);
    const settings = harnessSettings(config, harness);
    if (profiles.length === 0 || !settings.enabled) continue;
    const { listed, note } = await listModels(harness, settings.binary as string | undefined, list);
    for (const [profile, p] of profiles) {
      const status = checkModel(harness.models, p.model, listed);
      reports.push({
        profile,
        harness: harness.name,
        model: p.model,
        status,
        ...(status === "unchecked" && note ? { note } : {}),
      });
    }
  }
  return reports;
}

async function listModels(
  harness: HarnessDescriptor,
  configuredBinary: string | undefined,
  list: RunList,
): Promise<{ listed: ListedModel[] | null; note?: string }> {
  if (!harness.models.list) return { listed: null };
  const stdout = await list(findBinary(harness.binary, configuredBinary), harness.models.list.args);
  if (stdout === null) return { listed: null, note: "its model list could not be read" };
  const listed = harness.models.list.parse(stdout);
  return listed.length
    ? { listed }
    : { listed: null, note: "its model list was empty or unreadable" };
}

/** The `ocd doctor` lines for model checks: a warning per unlisted model, a note when not checkable. */
export function modelLines(reports: ModelReport[], label: (harness: string) => string): string[] {
  return reports.map((r) => {
    const who = `profile ${r.profile} (${label(r.harness)} ${r.model})`;
    if (r.status === "ok") return `${"model".padEnd(9)} ok ${who}`;
    if (r.status === "unknown")
      return `${"model".padEnd(9)} WARN ${who}: not in the harness's model list`;
    return `${"model".padEnd(9)} -- ${who}: not checkable${r.note ? ` (${r.note})` : ""}`;
  });
}

/**
 * What makes `ocd doctor` exit non-zero: an invalid config, no git, or an
 * enabled harness or tool that is unavailable. Tools that are off do not
 * count, and neither do model warnings.
 */
export function doctorProblems(input: {
  configError: string | null;
  git: string | null;
  harnesses: Pick<AdapterStatus, "harness" | "available">[];
  github: { enabled: boolean; available: boolean | null };
  tmux: { enabled: boolean; path: string | null };
}): string[] {
  return [
    ...(input.configError ? ["invalid config"] : []),
    ...(input.git ? [] : ["git not found"]),
    ...input.harnesses.filter((h) => !h.available).map((h) => `${h.harness} unavailable`),
    ...(input.github.enabled && !input.github.available ? ["gh unavailable"] : []),
    ...(input.tmux.enabled && !input.tmux.path ? ["tmux not found"] : []),
  ];
}
