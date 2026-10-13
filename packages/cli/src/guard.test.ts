import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { insideWorktree } from "./guard.ts";
import { addRepo, removeRepo } from "./repo-config.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "ocd-cli-"));
  dirs.push(d);
  return d;
}

describe("worktree guard", () => {
  it("refuses the live supervisor from inside an OCD worktree unless OCD_HOME is explicit", () => {
    const root = temp();
    const ws = join(root, "workspaces");
    mkdirSync(join(ws, "app", "t_1", "src"), { recursive: true });
    expect(insideWorktree(join(ws, "app", "t_1", "src"), ws, {})).toBe(true);
    expect(insideWorktree(root, ws, {})).toBe(false);
    expect(insideWorktree(join(ws, "app", "t_1"), ws, { OCD_HOME: "/sandbox" })).toBe(false);
  });
});

describe("ocd repo add / remove", () => {
  function setup() {
    const root = temp();
    const repo = join(root, "app");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    const real = join(root, "ocd.jsonc");
    writeFileSync(
      real,
      `{
  // my settings
  "repos": {
    "dotfiles": { "path": "~/.dotfiles" },
  },
  "profiles": { "fast": { "harness": "fake", "model": "m" } },
}
`,
    );
    const link = join(root, "link.jsonc");
    symlinkSync(real, link);
    return { repo, real, link };
  }

  it("adds a repo through the symlink, keeping comments, and validates input", () => {
    const { repo, real, link } = setup();
    const before = readFileSync(real, "utf8");
    addRepo(link, "app", join(repo, "."), "fast");
    const text = readFileSync(real, "utf8");
    // Only the new line is added; the rest of the file is byte-for-byte the same.
    expect(text).toBe(
      before.replace(
        '"dotfiles": { "path": "~/.dotfiles" },',
        `"dotfiles": { "path": "~/.dotfiles" },\n    "app": { "path": ${JSON.stringify(realpathSync(repo))}, "profile": "fast" },`,
      ),
    );
    expect(() => addRepo(link, "app", repo, undefined)).toThrow(/already declared/);
    expect(() => addRepo(link, "other", repo, "nope")).toThrow(/no profile "nope"/);
    expect(() => addRepo(link, "Bad Name", repo, undefined)).toThrow(/not a valid repo name/);
    expect(() => addRepo(link, "x", temp(), undefined)).toThrow(/not a git repository/);
    removeRepo(link, "app");
    expect(readFileSync(real, "utf8")).toBe(before);
    expect(() => removeRepo(link, "app")).toThrow(/no repo "app"/);
  });
});
