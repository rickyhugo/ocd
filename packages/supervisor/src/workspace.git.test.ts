import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeRepo, rmrf, tempDir } from "./testkit.ts";
import { WorkspaceManager } from "./workspace.ts";

describe("workspace git behaviour", () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  const setup = () => {
    const root = tempDir();
    const repo = makeRepo(root, "app");
    const manager = new WorkspaceManager(join(root, "ws"));
    const addTask = (name: string) => {
      const path = join(root, "ws", name);
      sh(repo, "worktree", "add", "-q", "-b", `ocd/${name}`, path);
      return realpathSync(path);
    };
    const commit = (cwd: string, file: string, content: string) => {
      writeFileSync(join(cwd, file), content);
      sh(cwd, "add", "-A");
      sh(cwd, "commit", "-q", "-m", `edit ${file}`);
    };
    return { root, repo, manager, addTask, commit };
  };

  it("removes a branch whose commits only exist on another branch, and is idempotent", async () => {
    const { root, repo, manager, addTask, commit } = setup();
    try {
      const ws = addTask("t1");
      commit(ws, "a.txt", "a\n");
      sh(repo, "branch", "keep", "ocd/t1");
      await manager.remove(repo, ws, "ocd/t1", false);
      expect(existsSync(ws)).toBe(false);
      expect(sh(repo, "branch", "--list", "ocd/t1")).toBe("");
      await manager.remove(repo, ws, "ocd/t1", false);
    } finally {
      rmrf(root);
    }
  });

  it("removes a missing worktree's entry without pruning the user's other worktrees", async () => {
    const { root, repo, manager, addTask } = setup();
    try {
      const ws = addTask("t2");
      const other = addTask("user-own");
      rmSync(ws, { recursive: true });
      rmSync(other, { recursive: true });
      await manager.remove(repo, ws, "ocd/t2", false);
      const listed = sh(repo, "worktree", "list", "--porcelain");
      expect(listed).not.toContain(ws);
      expect(listed).toContain(other);
      expect(sh(repo, "branch", "--list", "ocd/t2")).toBe("");
    } finally {
      rmrf(root);
    }
  });

  it("reports non-ASCII and tab paths unquoted from verify, filesChangedSince and diff", async () => {
    const { root, manager, addTask, commit } = setup();
    try {
      const ws = addTask("t3");
      const base = sh(ws, "rev-parse", "HEAD");
      commit(ws, "åäö.txt", "x\n");
      commit(ws, "tab\tname.txt", "x\n");
      writeFileSync(join(ws, "åäö.txt"), "y\n");
      const verified = await manager.verify({ path: ws, baseRef: base });
      expect(verified.changedFiles).toEqual(["tab\tname.txt", "åäö.txt"]);
      expect(await manager.filesChangedSince(ws, base)).toEqual(["tab\tname.txt", "åäö.txt"]);
      const diff = await manager.diff(ws, base);
      expect(diff.files.map((f) => [f.path, f.uncommitted])).toEqual([
        ["tab\tname.txt", false],
        ["åäö.txt", true],
      ]);
    } finally {
      rmrf(root);
    }
  });

  it("truncates a diff larger than the process buffer on a file boundary", async () => {
    const { root, manager, addTask } = setup();
    try {
      const ws = addTask("t4");
      const base = sh(ws, "rev-parse", "HEAD");
      writeFileSync(join(ws, "small.txt"), "small\n");
      sh(ws, "add", "small.txt");
      sh(ws, "commit", "-q", "-m", "small");
      writeFileSync(join(ws, "zbig.txt"), "line ö\n".repeat(3_000_000));
      sh(ws, "add", "zbig.txt");
      sh(ws, "commit", "-q", "-m", "big");
      const diff = await manager.diff(ws, base, 100_000);
      expect(diff.truncated).toBe(true);
      expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(100_000);
      expect(diff.patch).not.toContain("�");
      expect(diff.patch).toContain("small.txt");
      expect(diff.patch).not.toContain("zbig.txt");
      expect(diff.files.map((f) => f.path)).toEqual(["small.txt", "zbig.txt"]);
    } finally {
      rmrf(root);
    }
  });

  it("cuts a single huge file at a line boundary with valid UTF-8", async () => {
    const { root, manager, addTask } = setup();
    try {
      const ws = addTask("t5");
      const base = sh(ws, "rev-parse", "HEAD");
      writeFileSync(join(ws, "big.txt"), "ö€😀\n".repeat(5_000_000));
      sh(ws, "add", "big.txt");
      sh(ws, "commit", "-q", "-m", "big");
      const diff = await manager.diff(ws, base, 50_001);
      expect(diff.truncated).toBe(true);
      expect(diff.patch).not.toContain("�");
      expect(diff.patch.endsWith("\n")).toBe(true);
    } finally {
      rmrf(root);
    }
  });

  it("caps the number of untracked files it diffs", async () => {
    const { root, manager, addTask } = setup();
    try {
      const ws = addTask("t6");
      const base = sh(ws, "rev-parse", "HEAD");
      for (let i = 0; i < 55; i += 1) writeFileSync(join(ws, `u${i}.txt`), "x\n");
      const diff = await manager.diff(ws, base);
      expect(diff.truncated).toBe(true);
      expect(diff.files).toHaveLength(50);
    } finally {
      rmrf(root);
    }
  });

  it("refuses to land work that is already on the target, and skips emptied replays", async () => {
    const { root, repo, manager, addTask, commit } = setup();
    try {
      const ws = addTask("t7");
      commit(ws, "a.txt", "a\n");
      commit(ws, "b.txt", "b\n");
      const head = sh(ws, "rev-parse", "HEAD");
      // main gets the same a.txt content independently, plus another commit.
      commit(repo, "a.txt", "a\n");
      commit(repo, "c.txt", "c\n");
      const message = "land";
      const rebased = await manager.landingCommit(ws, {
        onto: "main",
        head,
        method: "rebase",
        message,
      });
      expect(sh(ws, "rev-list", "--count", `main..${rebased}`)).toBe("1");
      expect(sh(ws, "log", "-1", "--format=%s", rebased)).toBe("edit b.txt");
      // Land it on main, then everything is already there.
      sh(repo, "merge", "-q", "--ff-only", rebased);
      for (const method of ["squash", "merge", "rebase"] as const) {
        await expect(
          manager.landingCommit(ws, { onto: "main", head, method, message }),
        ).rejects.toMatchObject({ code: "nothing_to_push" });
      }
    } finally {
      rmrf(root);
    }
  });
});
