import { describe, expect, it } from "vite-plus/test";

import { codexModels } from "./codex-harness.ts";
import { baseModel, checkModel, defaultModel, pickableModels } from "./harness.ts";
import { opencodeModels } from "./opencode-harness.ts";
import {
  HARNESSES,
  buildHarnessAdapters,
  configurableHarnesses,
  findHarness,
  harnessSettings,
  labelOf,
  requireHarness,
} from "./registry.ts";

const sections = (overrides: Record<string, unknown> = {}) => ({
  allowFakeHarness: false,
  opencode: { enabled: true },
  claude: { enabled: false },
  codex: { enabled: false },
  ...overrides,
});

describe("the harness registry", () => {
  it("has one descriptor per harness, each building an adapter that carries its name", () => {
    expect(new Set(HARNESSES.map((h) => h.name)).size).toBe(HARNESSES.length);
    for (const h of HARNESSES) {
      const adapter = h.create({
        settings: { enabled: true },
        idleStopMs: 1000,
        findBinary: (name) => name,
      });
      expect(adapter.harness).toBe(h.name);
      expect(adapter.sessionsSurviveSupervisor).toBe(h.sessionsSurviveSupervisor);
    }
  });

  it("names the known harnesses when one is unknown", () => {
    expect(findHarness("nope")).toBeUndefined();
    expect(() => requireHarness("nope")).toThrow(/known: opencode, claude, codex, fake/);
    expect(labelOf("claude")).toBe("Claude Code");
    expect(labelOf("nope")).toBe("nope");
  });

  it("builds adapters for the enabled harnesses only, in registry order", () => {
    const build = (config: ReturnType<typeof sections>) =>
      buildHarnessAdapters(config, { idleStopMs: 1000, findBinary: (name) => name }).map(
        (a) => a.harness,
      );
    expect(build(sections())).toEqual(["opencode"]);
    expect(build(sections({ codex: { enabled: true }, claude: { enabled: true } }))).toEqual([
      "opencode",
      "claude",
      "codex",
    ]);
    // The fake harness has no section; allowFakeHarness switches it on.
    expect(build(sections({ allowFakeHarness: true, opencode: { enabled: false } }))).toEqual([
      "fake",
    ]);
  });

  it("reads a harness's settings from its section, or from allowFakeHarness when it has none", () => {
    expect(harnessSettings(sections(), requireHarness("codex")).enabled).toBe(false);
    expect(harnessSettings(sections(), requireHarness("fake")).enabled).toBe(false);
    expect(
      harnessSettings(sections({ allowFakeHarness: true }), requireHarness("fake")).enabled,
    ).toBe(true);
    expect(configurableHarnesses().map((h) => h.name)).not.toContain("fake");
  });
});

describe("profile models", () => {
  const opencode = requireHarness("opencode").models;
  const claude = requireHarness("claude").models;
  const codex = requireHarness("codex").models;

  it("strips the #variant suffix", () => {
    expect(baseModel("openai/gpt-5#high")).toBe("openai/gpt-5");
    expect(baseModel("sonnet")).toBe("sonnet");
  });

  it("checks against the harness's own list", () => {
    const listed = opencodeModels("openai/gpt-5\nanthropic/sonnet\nnot a model\n");
    expect(listed.map((m) => m.name)).toEqual(["openai/gpt-5", "anthropic/sonnet"]);
    expect(checkModel(opencode, "openai/gpt-5#high", listed)).toBe("ok");
    expect(checkModel(opencode, "openai/gpt-9", listed)).toBe("unknown");
    // No list (command failed): nothing to check against.
    expect(checkModel(opencode, "openai/gpt-9", null)).toBe("unchecked");
  });

  it("accepts aliases, and reports what has no list as not checkable", () => {
    expect(checkModel(claude, "sonnet#high", null)).toBe("ok");
    expect(checkModel(claude, "claude-sonnet-4-5", null)).toBe("unchecked");
  });

  it("reads Codex's models in its order, hidden ones accepted but not offered", () => {
    const listed = codexModels(
      JSON.stringify({
        models: [
          { slug: "b", visibility: "list", priority: 2 },
          { slug: "hidden", visibility: "hide", priority: 0 },
          { slug: "a", visibility: "list", priority: 0 },
        ],
      }),
    );
    expect(pickableModels(codex, listed)).toEqual(["a", "b"]);
    expect(checkModel(codex, "hidden", listed)).toBe("ok");
    expect(codexModels("not json")).toEqual([]);
  });

  it("offers aliases when nothing is listed, and prefers a listed model when told to", () => {
    expect(pickableModels(claude, null)).toEqual(["sonnet", "opus", "haiku"]);
    const options = ["openai/gpt-5", "anthropic/sonnet-4"];
    expect(defaultModel(opencode, options)).toBe("anthropic/sonnet-4");
    expect(defaultModel(codex, ["x", "y"])).toBe("x");
    expect(defaultModel(codex, [])).toBe("");
  });

  it("enforces OpenCode's provider/model spelling", () => {
    expect(opencode.format!.pattern.test("anthropic/sonnet")).toBe(true);
    expect(opencode.format!.pattern.test("sonnet")).toBe(false);
  });
});
