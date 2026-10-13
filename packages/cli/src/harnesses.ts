import { execFile } from "node:child_process";

import { FakeAdapter, OpenCodeAdapter, discoverOpenCode, type HarnessAdapter } from "@ocd/adapters";
import type { AdapterStatus } from "@ocd/core";
import type { Logger, ManagerChannel, SupervisorConfig } from "@ocd/supervisor";

export function buildAdapters({
  config,
  logger,
}: {
  config: SupervisorConfig;
  logger: Logger;
}): HarnessAdapter[] {
  const adapters: HarnessAdapter[] = [];
  if (config.opencode.enabled) {
    const serviceFile = config.opencode.serviceFile;
    adapters.push(
      new OpenCodeAdapter({
        connect: () => discoverOpenCode(serviceFile ? { serviceFile } : {}),
        onError: (error, context) => logger.warn({ err: error, context }, "opencode adapter error"),
      }),
    );
  }
  if (config.allowFakeHarness) adapters.push(new FakeAdapter());
  return adapters;
}

/** The registered manager is an OpenCode session, so wake-ups go through the OpenCode adapter. */
export function buildManagerChannel(adapters: HarnessAdapter[]): ManagerChannel | null {
  const opencode = adapters.find((a): a is OpenCodeAdapter => a instanceof OpenCodeAdapter);
  return opencode ? { wake: (sessionId, text) => opencode.wakeManager(sessionId, text) } : null;
}

function version(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : (String(stdout).trim().split("\n")[0] ?? null)),
    );
  });
}

/** Read-only checks: binary versions and the OpenCode service. Never creates sessions or spends tokens. */
export async function probeHarnesses(): Promise<AdapterStatus[]> {
  const results: AdapterStatus[] = [];
  for (const harness of ["opencode", "claude", "codex"] as const) {
    const v = await version(harness);
    const problems =
      v === null
        ? [`${harness} not found on PATH`]
        : harness === "opencode"
          ? []
          : ["adapter not implemented yet (milestone 4)"];
    results.push({ harness, available: v !== null, version: v, problems });
  }
  const service = await new OpenCodeAdapter({ connect: () => discoverOpenCode() }).probe();
  results.push({
    ...service,
    problems: [`service ${service.available ? "reachable" : "not reachable"}`, ...service.problems],
  });
  return results;
}
