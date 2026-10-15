import { CodexAdapter } from "./codex.ts";
import type { HarnessDescriptor, ListedModel } from "./harness.ts";

/** Codex's models, in its own order (`codex debug models`); hidden ones are valid but not offered. */
export function codexModels(stdout: string): ListedModel[] {
  try {
    const models = (
      JSON.parse(stdout) as { models?: { slug: string; visibility?: string; priority?: number }[] }
    ).models;
    return (models ?? [])
      .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((m) => ({
        name: m.slug,
        ...(m.visibility === undefined || m.visibility === "list" ? {} : { hidden: true }),
      }));
  } catch {
    return [];
  }
}

export const codexHarness: HarnessDescriptor = {
  name: "codex",
  label: "Codex",
  binary: "codex",
  config: {
    defaultEnabled: false,
    enabledDescription:
      "Offer Codex workers (profiles with harness codex). Off by default; when off, codex is never run and dispatches to its profiles are refused. Restart to apply.",
    options: [
      {
        key: "binary",
        description:
          "Absolute path of the codex binary; defaults to a lookup on the PATH your login shell sets up.",
      },
    ],
  },
  sessionsSurviveSupervisor: false,
  usageLimits: "readable",
  profileName: "codex",
  create: ({ settings, idleStopMs, findBinary, onError }) =>
    new CodexAdapter({
      command: [findBinary("codex", settings["binary"] as string | undefined), "app-server"],
      idleStopMs,
      ...(onError ? { onError } : {}),
    }),
  login: { args: ["login", "status"], hint: "run `codex login`" },
  models: { list: { args: ["debug", "models"], parse: codexModels } },
};
