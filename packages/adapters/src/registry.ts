import { claudeHarness } from "./claude-harness.ts";
import { codexHarness } from "./codex-harness.ts";
import { fakeHarness } from "./fake-harness.ts";
import type { HarnessContext, HarnessDescriptor, HarnessSettings } from "./harness.ts";
import { opencodeHarness } from "./opencode-harness.ts";
import type { HarnessAdapter } from "./types.ts";

/** Every harness OCD knows. Adding one is a descriptor next to its adapter and a line here. */
export const HARNESSES: readonly HarnessDescriptor[] = [
  opencodeHarness,
  claudeHarness,
  codexHarness,
  fakeHarness,
];

export function findHarness(name: string): HarnessDescriptor | undefined {
  return HARNESSES.find((h) => h.name === name);
}

/** The descriptor, or an error naming the known harnesses. */
export function requireHarness(name: string): HarnessDescriptor {
  const harness = findHarness(name);
  if (!harness) throw new Error(`Unknown harness "${name}"; known: ${harnessNames().join(", ")}`);
  return harness;
}

export function harnessNames(): string[] {
  return HARNESSES.map((h) => h.name);
}

/** "Claude Code" for claude; the name itself for a harness this build does not know. */
export function labelOf(name: string): string {
  return findHarness(name)?.label ?? name;
}

/** The harnesses with an ocd.jsonc section (all but test harnesses). */
export function configurableHarnesses(): HarnessDescriptor[] {
  return HARNESSES.filter((h) => h.config !== null);
}

/** The settings of a harness from a loaded config (its section; `allowFakeHarness` for sectionless ones). */
export function harnessSettings(
  config: { allowFakeHarness: boolean } & Record<string, unknown>,
  harness: HarnessDescriptor,
): HarnessSettings {
  if (!harness.config) return { enabled: config.allowFakeHarness };
  return config[harness.name] as HarnessSettings;
}

/** The adapters for every enabled harness. */
export function buildHarnessAdapters(
  config: Parameters<typeof harnessSettings>[0],
  context: Omit<HarnessContext, "settings" | "onError"> & {
    onError?: (harness: string, error: unknown, context: string) => void;
  },
): HarnessAdapter[] {
  const { onError, ...rest } = context;
  return HARNESSES.flatMap((h) => {
    const settings = harnessSettings(config, h);
    if (!settings.enabled) return [];
    return [
      h.create({
        ...rest,
        settings,
        ...(onError ? { onError: (error, ctx) => onError(h.name, error, ctx) } : {}),
      }),
    ];
  });
}
