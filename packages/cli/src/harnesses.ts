import { execFile } from "node:child_process";

import { FakeAdapter, type HarnessAdapter } from "@ocd/adapters";
import type { AdapterStatus } from "@ocd/core";
import type { Logger, ManagerChannel, SupervisorConfig } from "@ocd/supervisor";

export function buildAdapters({
  config,
}: {
  config: SupervisorConfig;
  logger: Logger;
}): HarnessAdapter[] {
  const adapters: HarnessAdapter[] = [];
  if (config.allowFakeHarness) adapters.push(new FakeAdapter());
  return adapters;
}

export function buildManagerChannel(_adapters: HarnessAdapter[]): ManagerChannel | null {
  return null;
}

function version(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : (String(stdout).trim().split("\n")[0] ?? null)),
    );
  });
}

/** Read-only checks: binary presence and versions. Never starts sessions or spends tokens. */
export async function probeHarnesses(): Promise<AdapterStatus[]> {
  const results: AdapterStatus[] = [];
  for (const harness of ["opencode", "claude", "codex"] as const) {
    const v = await version(harness);
    results.push({
      harness,
      available: v !== null,
      version: v,
      problems:
        v === null
          ? [`${harness} not found on PATH`]
          : harness === "opencode"
            ? []
            : ["adapter not implemented yet (milestone 4)"],
    });
  }
  return results;
}
