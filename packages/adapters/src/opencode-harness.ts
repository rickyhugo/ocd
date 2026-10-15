import type { HarnessDescriptor, ListedModel } from "./harness.ts";
import { OpenCodeAdapter, discoverOpenCode } from "./opencode.ts";

const PROVIDER_MODEL = /^[^/\s]+\/\S+$/;

/** `opencode models` prints one provider/model per line. */
export function opencodeModels(stdout: string): ListedModel[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => PROVIDER_MODEL.test(l))
    .map((name) => ({ name }));
}

export const opencodeHarness: HarnessDescriptor = {
  name: "opencode",
  label: "OpenCode",
  binary: "opencode",
  config: {
    defaultEnabled: true,
    enabledDescription:
      "Offer OpenCode workers (profiles with harness opencode) and wake the manager through the OpenCode service.",
    options: [
      {
        key: "serviceFile",
        description:
          "OpenCode service registration file; defaults to OpenCode's own discovery path.",
      },
    ],
  },
  sessionsSurviveSupervisor: true,
  profileName: "oc",
  create: ({ settings, onError }) => {
    const serviceFile = settings["serviceFile"] as string | undefined;
    return new OpenCodeAdapter({
      connect: () => discoverOpenCode(serviceFile ? { serviceFile } : {}),
      ...(onError ? { onError } : {}),
    });
  },
  decorateProbe: (status) => ({
    ...status,
    problems: [`service ${status.available ? "reachable" : "not reachable"}`, ...status.problems],
  }),
  models: {
    format: {
      pattern: PROVIDER_MODEL,
      message: "OpenCode models are written provider/model",
      hint: "provider/model",
    },
    list: { args: ["models"], parse: opencodeModels },
    preferred: /sonnet/,
  },
};
