import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitHubCliStatus } from "@ocd/core";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { checkGh, describeGh, ghServiceHints, miseShim, serviceGh } from "./github.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocd-cli-gh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function executable(dir: string, name = "gh"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
}

const ok: GitHubCliStatus = {
  available: true,
  path: "/shell/bin/gh",
  source: "path",
  version: "2.100.0",
  auth: "ok",
  problem: null,
  problems: [],
  checkedAt: new Date(0).toISOString(),
};

describe("gh as the background service sees it", () => {
  it("looks gh up on the service PATH, or uses gh.binary", () => {
    const gh = executable(join(root, "svc"));
    expect(serviceGh({ configured: null, servicePath: join(root, "svc") })).toEqual({
      path: gh,
      problem: null,
    });
    expect(serviceGh({ configured: null, servicePath: "/usr/nonexistent" })).toEqual({
      path: null,
      problem: "not_found",
    });
    expect(serviceGh({ configured: gh, servicePath: "" }).path).toBe(gh);
    expect(serviceGh({ configured: join(root, "nope"), servicePath: "" }).problem).toBe(
      "invalid_path",
    );
  });

  it("suggests gh.binary only when the shell finds gh and the service would not", () => {
    const missing = { path: null, problem: "not_found" };
    expect(
      ghServiceHints({ configured: null, shellPath: "/mise/installs/gh/bin/gh", service: missing }),
    ).toEqual([
      "the background service's PATH has no gh, but your shell finds /mise/installs/gh/bin/gh. Add to ocd.jsonc (applies on save):",
      '  "gh": { "binary": "/mise/installs/gh/bin/gh" }',
    ]);
    // A mise shim is preferred: it survives gh upgrades.
    expect(
      ghServiceHints({
        configured: null,
        shellPath: "/mise/installs/gh/bin/gh",
        service: missing,
        shim: "/mise/shims/gh",
      })[1],
    ).toBe('  "gh": { "binary": "/mise/shims/gh" }');
    expect(ghServiceHints({ configured: "/x/gh", shellPath: "/x/gh", service: missing })).toEqual(
      [],
    );
    expect(
      ghServiceHints({
        configured: null,
        shellPath: "/a/gh",
        service: { path: "/b/gh", problem: null },
      }),
    ).toEqual([]);
    expect(ghServiceHints({ configured: null, shellPath: null, service: missing })).toEqual([]);
    expect(ghServiceHints({ configured: null, shellPath: "/a/gh", service: null })).toEqual([]);
  });

  it("finds mise's shim directory from the environment", () => {
    executable(join(root, "mise", "shims"));
    expect(miseShim("gh", { MISE_DATA_DIR: join(root, "mise") })).toBe(
      join(root, "mise", "shims", "gh"),
    );
    expect(miseShim("gh", { XDG_DATA_HOME: root })).toBe(join(root, "mise", "shims", "gh"));
    expect(miseShim("gh", { MISE_DATA_DIR: join(root, "none") })).toBeNull();
  });

  it("checkGh combines the shell probe with the service lookup", async () => {
    const report = await checkGh(
      { configured: null, extraDirs: [], servicePath: "/usr/nonexistent" },
      async () => ok,
    );
    expect(report.service).toEqual({ path: null, problem: "not_found" });
    expect(report.hints[1]).toContain('"gh": { "binary"');
    const noService = await checkGh(
      { configured: null, extraDirs: [], servicePath: null },
      async () => ok,
    );
    expect(noService).toMatchObject({ service: null, hints: [] });
  });
});

describe("describing gh status", () => {
  it("is explicit about the source, login and problems", () => {
    expect(describeGh(ok)).toBe("ok 2.100.0 /shell/bin/gh (PATH), logged in");
    expect(
      describeGh({
        ...ok,
        source: "config",
        auth: "unknown",
        problem: "unreachable",
        problems: ["GitHub could not be reached"],
      }),
    ).toBe("ok 2.100.0 /shell/bin/gh (gh.binary), login not verified; GitHub could not be reached");
    expect(describeGh({ ...ok, auth: "missing", problems: ["Run `gh auth login`"] })).toContain(
      "login missing",
    );
    expect(
      describeGh({ ...ok, available: false, path: null, problems: ["gh was not found"] }),
    ).toBe("UNAVAILABLE gh was not found");
  });
});
