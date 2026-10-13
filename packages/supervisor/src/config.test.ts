import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ConfigError, loadConfig, toProfiles } from "./config.ts";
import { configJsonSchema } from "./config-schema.ts";
import { rmrf, setupRepo, startHarness, tempDir, type Harness } from "./testkit.ts";

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

  it("ships a JSON Schema that matches the code (run `pnpm run schema` after config changes)", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../../schema/ocd.schema.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(configJsonSchema());
  });
});

describe("profile reload", () => {
  it("reloads profiles from the file, keeps the old set when the file is invalid", async () => {
    h = await startHarness();
    writeFileSync(
      h.paths.config,
      `{ "allowFakeHarness": true, "profiles": { "cheap": { "harness": "fake", "model": "fake/small", "description": "Chores" } } }`,
    );
    const { profiles } = await h.human.reload();
    expect(profiles.map((p) => p.name)).toEqual(["cheap", "fake"]);
    expect((await h.human.listProfiles()).find((p) => p.name === "cheap")?.description).toBe(
      "Chores",
    );

    writeFileSync(h.paths.config, `{ "profiles": { "cheap": { "harness": "fake" } } }`);
    await expect(h.human.reload()).rejects.toMatchObject({ code: "invalid_config" });
    expect((await h.human.listProfiles()).map((p) => p.name)).toEqual(["cheap", "fake"]);

    await h.human.registerManager({ sessionId: "mgr", directory: h.root });
    await expect(h.manager("mgr").reload()).rejects.toMatchObject({ code: "human_only" });
  });

  it("refuses repositories whose default profile is not declared", async () => {
    h = await startHarness();
    await expect(setupRepo(h, "app", "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps the dispatched profile snapshot when the profile changes later", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "snapshot-1",
    });
    writeFileSync(
      h.paths.config,
      `{ "profiles": { "fake": { "harness": "fake", "model": "fake/other", "permissionPolicy": "deny" } } }`,
    );
    await h.human.reload();
    // Test overrides still win for "fake"; the task's snapshot is unaffected either way.
    expect((await h.human.inspectTask(task.id)).task.profile.model).toBe("fake/model");
  });
});
