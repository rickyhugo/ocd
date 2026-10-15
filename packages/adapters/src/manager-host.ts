import { execFile } from "node:child_process";

import { OpenCodeAdapter } from "./opencode.ts";
import { harnessSettings, requireHarness } from "./registry.ts";
import type { HarnessAdapter } from "./types.ts";

// OpenCode has a second role besides being a harness: it hosts the manager.
// The manager is an OpenCode session running the OCD plugin; the supervisor
// wakes it through the OpenCode service and reloads OpenCode's plugins after a
// self-update. That role is not a harness concern, so it lives behind this one
// seam instead of being scattered as `instanceof` checks and string literals.

export interface ManagerHost {
  /** For people: "OpenCode". */
  label: string;
  /** Executable of the host. */
  binary: string;
  /** The harness whose adapter delivers wake-ups (its descriptor name). */
  harness: string;
  /** Delivers supervisor updates into a manager session; null when the adapter is not running. */
  channel(
    adapters: HarnessAdapter[],
  ): { wake(sessionId: string, text: string): Promise<void> } | null;
  /** Makes the host reload its plugins (after a switch to a new OCD version). */
  reload(): Promise<void>;
}

/** Whether the host's own harness is on in this config (it is by default). */
export function managerHostEnabled(config: Parameters<typeof harnessSettings>[0]): boolean {
  return harnessSettings(config, requireHarness(MANAGER_HOST.harness)).enabled;
}

export const MANAGER_HOST: ManagerHost = {
  label: "OpenCode",
  binary: "opencode",
  harness: "opencode",
  channel(adapters) {
    const host = adapters.find((a): a is OpenCodeAdapter => a instanceof OpenCodeAdapter);
    return host ? { wake: (sessionId, text) => host.wakeManager(sessionId, text) } : null;
  },
  reload() {
    return new Promise((resolve, reject) =>
      execFile("opencode", ["reload"], { timeout: 30_000 }, (error, _out, stderr) =>
        error
          ? reject(new Error(`opencode reload: ${String(stderr).trim() || error.message}`))
          : resolve(),
      ),
    );
  },
};
