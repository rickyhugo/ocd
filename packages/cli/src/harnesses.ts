import {
  ClaudeAdapter,
  CodexAdapter,
  FakeAdapter,
  OpenCodeAdapter,
  discoverOpenCode,
  type HarnessAdapter,
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
  if (config.claude.enabled) {
    adapters.push(
      new ClaudeAdapter({
        command: [findBinary("claude", config.claude.binary)],
        idleStopMs: config.workerIdleMinutes * 60_000,
        onError: (error, context) => logger.warn({ err: error, context }, "claude adapter error"),
      }),
    );
  }
  if (config.codex.enabled) {
    adapters.push(
      new CodexAdapter({
        command: [findBinary("codex", config.codex.binary), "app-server"],
        idleStopMs: config.workerIdleMinutes * 60_000,
        onError: (error, context) => logger.warn({ err: error, context }, "codex adapter error"),
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

/** Read-only checks: binary versions, logins, and the OpenCode service. Never starts workers or spends tokens. */
export async function probeHarnesses(): Promise<AdapterStatus[]> {
  const opencode = await new OpenCodeAdapter({ connect: () => discoverOpenCode() }).probe();
  return [
    {
      ...opencode,
      problems: [
        `service ${opencode.available ? "reachable" : "not reachable"}`,
        ...opencode.problems,
      ],
    },
    await new ClaudeAdapter({ command: [findBinary("claude")] }).probe(),
    await new CodexAdapter({ command: [findBinary("codex"), "app-server"] }).probe(),
  ];
}
