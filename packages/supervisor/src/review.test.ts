import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function reviewable(key: string) {
  h = await startHarness();
  await setupRepo(h, "app");
  const { task } = await h.manager("mgr").dispatch({
    repo: "app",
    title: "Write the file",
    instructions: "x",
    idempotencyKey: `review-test-${key}`,
  });
  return (await waitForState(h, task.id, "ready_for_review")).task;
}

describe("review: diff", () => {
  it("shows committed, uncommitted, untracked, deleted and binary changes since the branch left its base", async () => {
    const task = await reviewable("diff");
    const ws = task.workspacePath!;
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "worker commit");
    git(ws, "rm", "-q", "README.md");
    git(ws, "commit", "-q", "-m", "drop readme");
    writeFileSync(join(ws, "ocd-fake.txt"), "changed after the commit\n");
    writeFileSync(join(ws, "new.txt"), "untracked\n");
    writeFileSync(join(ws, "blob.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const before = git(ws, "status", "--porcelain");

    const d = await h!.human.taskDiff(task.id);
    expect(d).toMatchObject({ taskId: task.id, branch: task.branch, baseRef: task.baseRef });
    expect(d.files).toEqual([
      { path: "README.md", status: "deleted", additions: 0, deletions: 1, uncommitted: false },
      { path: "blob.bin", status: "added", additions: null, deletions: null, uncommitted: true },
      { path: "new.txt", status: "added", additions: 1, deletions: 0, uncommitted: true },
      { path: "ocd-fake.txt", status: "added", additions: 1, deletions: 0, uncommitted: true },
    ]);
    expect(d.patch).toContain("+changed after the commit");
    expect(d.patch).toContain("+untracked");
    expect(d.truncated).toBe(false);
    // Read-only: nothing staged, nothing committed.
    expect(git(ws, "status", "--porcelain")).toBe(before);
    expect(git(ws, "log", "-1", "--format=%s")).toBe("drop readme");
  });

  it("refuses a task without a worktree", async () => {
    const task = await reviewable("gone");
    unlinkSync(join(task.workspacePath!, "ocd-fake.txt"));
    await h!.human.cancelTask(task.id).catch(() => undefined);
    await h!.human.cleanupTask(task.id, true);
    await expect(h!.human.taskDiff(task.id)).rejects.toMatchObject({ code: "no_workspace" });
  });
});

describe("review: request changes", () => {
  it("sends numbered feedback to the same worker and brings the task back for review", async () => {
    const task = await reviewable("changes");
    const reopened = await h!.manager("mgr").requestChanges(task.id, "Rename the file");
    expect(reopened.state).toBe("running");
    await waitForState(h!, task.id, "ready_for_review");
    await h!.human.requestChanges(task.id, "Add a test");
    const back = await waitForState(h!, task.id, "ready_for_review");
    expect(back.task.sessionId).toBe(task.sessionId);

    const rounds = back.events.filter((e) => e.type === "review.changes_requested");
    expect(rounds.map((e) => e.data)).toEqual([
      { round: 1, actor: "manager", feedback: "Rename the file" },
      { round: 2, actor: "human", feedback: "Add a test" },
    ]);
    await expect(h!.human.acceptTask(task.id)).resolves.toMatchObject({ state: "completed" });
    await expect(h!.human.requestChanges(task.id, "too late")).rejects.toMatchObject({
      code: "not_reviewable",
    });
  });
});
