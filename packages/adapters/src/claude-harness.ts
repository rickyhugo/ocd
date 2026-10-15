import { ClaudeAdapter } from "./claude.ts";
import type { HarnessDescriptor } from "./harness.ts";

export const claudeHarness: HarnessDescriptor = {
  name: "claude",
  label: "Claude Code",
  binary: "claude",
  config: {
    defaultEnabled: false,
    enabledDescription:
      "Offer Claude Code workers (profiles with harness claude). Off by default; when off, claude is never run and dispatches to its profiles are refused. Restart to apply.",
    options: [
      {
        key: "binary",
        description:
          "Absolute path of the claude binary; defaults to a lookup on the PATH your login shell sets up.",
      },
    ],
  },
  sessionsSurviveSupervisor: false,
  usageLimits: "reported",
  profileName: "cc",
  create: ({ settings, idleStopMs, findBinary, onError }) =>
    new ClaudeAdapter({
      command: [findBinary("claude", settings["binary"] as string | undefined)],
      idleStopMs,
      ...(onError ? { onError } : {}),
    }),
  login: { args: ["auth", "status", "--json"], hint: "run `claude` and /login" },
  // No list command: the aliases are what can be checked (and offered), full ids are taken as given.
  models: { aliases: ["sonnet", "opus", "haiku"] },
};
