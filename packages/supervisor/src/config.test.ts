import { readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { harnessSettings, requireHarness } from "@ocd/adapters";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ConfigError, checkConfigFile, loadConfig, toProfiles } from "./config.ts";
import { configJsonSchema } from "./config-schema.ts";
import { rmrf, setupRepo, startHarness, tempDir, waitFor, type Harness } from "./testkit.ts";

const dirs: string[] = [];
let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
  dirs.splice(0).forEach(rmrf);
});

function writeConfig(text: string): string {
  const dir = tempDir();
  dirs.push(dir);
  const path = join(dir, "ocd.jsonc");
  writeFileSync(path, text);
  return path;
}

describe("ocd.jsonc", () => {
  it("accepts comments and trailing commas and applies defaults", () => {
    const config = loadConfig(
      writeConfig(`{
        // two workers at most
        "concurrency": 2,
        "profiles": {
          "oc": { "harness": "opencode", "model": "anthropic/claude-x#high", "description": "Default", },
          "oc-cheap": { "harness": "opencode", "model": "openai/gpt-mini", "permissionPolicy": "ask" },
        },
      }`),
    );
    expect(config.concurrency).toBe(2);
    expect(config.stallAfterMinutes).toBe(30);
    // Optional tools stay off unless turned on.
    expect([
      config.github.enabled,
      config.tmux.enabled,
      harnessSettings(config, requireHarness("claude")).enabled,
      harnessSettings(config, requireHarness("codex")).enabled,
    ]).toEqual([false, false, false, false]);
    expect(toProfiles(config).map((p) => [p.name, p.permissionPolicy, p.description])).toEqual([
      ["oc", "deny", "Default"],
      ["oc-cheap", "ask", null],
    ]);
  });

  it("treats a missing file as all defaults", () => {
    expect(loadConfig("/nonexistent/ocd.jsonc").profiles).toEqual({});
  });

  it("rejects typos, malformed JSONC, and invalid profiles with readable errors", () => {
    expect(() => loadConfig(writeConfig(`{ "concurrancy": 2 }`))).toThrow(/concurrancy/);
    expect(() =>
      loadConfig(
        writeConfig(`{ "profiles": { "oc": { "harness": "opencode", "model": "gpt" } } }`),
      ),
    ).toThrow(/profiles\.oc\.model: OpenCode models are written provider\/model/);
    expect(() =>
      loadConfig(
        writeConfig(
          `{ "profiles": { "oc": { "harness": "opencode", "model": "a/b", "verify": [] } } }`,
        ),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        writeConfig(`{ "profiles": { "Bad Name": { "harness": "fake", "model": "x" } } }`),
      ),
    ).toThrow(ConfigError);
    expect(() => loadConfig(writeConfig(`{ "concurrency": }`))).toThrow(/not valid JSONC/);
  });

  it("checks a file into a valid flag and the errors without the path, for `ocd config check --json`", () => {
    const valid = writeConfig(`{ "concurrency": 2 }`);
    expect(checkConfigFile(valid)).toEqual({ path: valid, valid: true });
    const typo = writeConfig(
      `{ "concurrancy": 2, "profiles": { "Bad Name": { "harness": "fake", "model": "x" } } }`,
    );
    expect(checkConfigFile(typo)).toEqual({
      path: typo,
      valid: false,
      errors: [
        "profiles.Bad Name: Invalid key in record",
        '(root): Unrecognized key: "concurrancy"',
      ],
    });
    const malformed = writeConfig(`{ "concurrency": }`);
    expect(checkConfigFile(malformed)).toEqual({
      path: malformed,
      valid: false,
      errors: ["not valid JSONC: ValueExpected at offset 17"],
    });
    const array = writeConfig(`[]`);
    expect(checkConfigFile(array)).toEqual({
      path: array,
      valid: false,
      errors: ["must contain a JSON object"],
    });
  });

  it("names the known harnesses when a profile uses an unknown one", () => {
    expect(() =>
      loadConfig(writeConfig(`{ "profiles": { "x": { "harness": "gemini", "model": "m" } } }`)),
    ).toThrow(
      /profiles\.x\.harness: Unknown harness "gemini"; known: opencode, claude, codex, fake/,
    );
  });

  it("keeps the per-harness sections and their strictness", () => {
    const config = loadConfig(
      writeConfig(
        `{ "claude": { "enabled": true, "binary": "/opt/claude" }, "opencode": { "serviceFile": "/tmp/svc" } }`,
      ),
    );
    expect(harnessSettings(config, requireHarness("claude"))).toEqual({
      enabled: true,
      binary: "/opt/claude",
    });
    expect(harnessSettings(config, requireHarness("opencode"))).toEqual({
      enabled: true,
      serviceFile: "/tmp/svc",
    });
    expect(harnessSettings(config, requireHarness("codex")).enabled).toBe(false);
    expect(() =>
      loadConfig(writeConfig(`{ "codex": { "enabled": true, "serviceFile": "x" } }`)),
    ).toThrow(/serviceFile/);
    expect(() => loadConfig(writeConfig(`{ "fake": { "enabled": true } }`))).toThrow(/fake/);
  });

  it("ships a JSON Schema that matches the code (run `pnpm run schema` after config changes)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../../schema/ocd.schema.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(configJsonSchema());
  });
});

/** Writes like an editor: a new file renamed over the old one. */
function saveLikeEditor(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

const profileNames = (h: Harness) => h.human.listProfiles().then((ps) => ps.map((p) => p.name));

describe("hot reload of ocd.jsonc", () => {
  it("applies saved profile changes, keeps the last good set when invalid, and recovers", async () => {
    h = await startHarness();
    const harness = h;
    saveLikeEditor(
      harness.paths.config,
      `{ "allowFakeHarness": true, "profiles": { "cheap": { "harness": "fake", "model": "fake/small", "description": "Chores" } } }`,
    );
    await waitFor(
      () => profileNames(harness),
      (names) => names.includes("cheap"),
    );
    expect((await harness.human.listProfiles()).find((p) => p.name === "cheap")?.description).toBe(
      "Chores",
    );

    writeFileSync(harness.paths.config, `{ "profiles": { "cheap": { "harness": "fake" } } }`);
    const invalid = await waitFor(
      () => harness.human.listAttention({ status: "open" }),
      (items) => items.some((a) => a.reason.startsWith("ocd.jsonc is invalid")),
    );
    expect(invalid.filter((a) => a.reason.startsWith("ocd.jsonc is invalid"))).toHaveLength(1);
    expect(await profileNames(harness)).toEqual(["cheap", "fake"]);

    saveLikeEditor(
      harness.paths.config,
      `{ "profiles": { "big": { "harness": "fake", "model": "fake/large" } } }`,
    );
    await waitFor(
      () => profileNames(harness),
      (names) => names.includes("big") && !names.includes("cheap"),
    );
    const open = await harness.human.listAttention({ status: "open" });
    expect(open.some((a) => a.reason.startsWith("ocd.jsonc is invalid"))).toBe(false);
  });

  it("follows a symlinked ocd.jsonc into another directory", async () => {
    h = await startHarness();
    const harness = h;
    await harness.daemon.stop();
    const repoDir = tempDir();
    dirs.push(repoDir);
    const target = join(repoDir, "ocd.jsonc");
    writeFileSync(target, `{ "profiles": {} }`);
    symlinkSync(target, harness.paths.config);
    await harness.restart();
    saveLikeEditor(
      target,
      `{ "profiles": { "linked": { "harness": "fake", "model": "fake/x" } } }`,
    );
    await waitFor(
      () => profileNames(harness),
      (names) => names.includes("linked"),
    );
  });

  it("refuses repositories whose default profile is not declared", async () => {
    h = await startHarness();
    await expect(setupRepo(h, "app", "nope")).rejects.toThrow(/Profile "nope" is not declared/);
  });

  it("keeps the dispatched profile snapshot when profiles change later", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    const harness = h;
    await setupRepo(harness, "app");
    const { task } = await harness.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "snapshot-1",
    });
    saveLikeEditor(
      harness.paths.config,
      `{ "profiles": { "extra": { "harness": "fake", "model": "fake/other" } } }`,
    );
    await waitFor(
      () => profileNames(harness),
      (names) => names.includes("extra"),
    );
    expect((await harness.human.inspectTask(task.id)).task.profile.model).toBe("fake/model");
  });
});

describe("overlapping reloads", () => {
  it("settle in order, so the last saved file wins", async () => {
    h = await startHarness();
    const harness = h;
    const save = (name: string) =>
      writeFileSync(
        harness.paths.config,
        `{ "profiles": { "${name}": { "harness": "fake", "model": "fake/x" } } }`,
      );
    save("first");
    const a = harness.daemon.reload();
    save("second");
    const b = harness.daemon.reload();
    save("third");
    const c = harness.daemon.reload();
    await Promise.all([a, b, c]);
    const names = await profileNames(harness);
    expect(names).toContain("third");
    expect(names).not.toContain("first");
    expect(names).not.toContain("second");
  });
});

describe("invalid config reporting", () => {
  it("keeps one inbox item that always shows the current error", async () => {
    h = await startHarness();
    const harness = h;
    writeFileSync(harness.paths.config, `{ "concurrancy": 1 }`);
    await harness.daemon.reload();
    writeFileSync(harness.paths.config, `{ "profiles": { "x": { "harness": "nope" } } }`);
    await harness.daemon.reload();
    const items = (await harness.human.listAttention({ status: "open" })).filter((a) =>
      a.reason.startsWith("ocd.jsonc is invalid"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toMatch(/profiles\.x/);
    expect(items[0]?.reason).not.toMatch(/concurrancy/);
  });
});
