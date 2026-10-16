import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMode } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SimulatedCrash } from "./errors.ts";
import type { CrashPoint } from "./supervisor.ts";
import { setupRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const branches = (repo: string) =>
  execFileSync("git", ["branch", "--list", "--format=%(refname:short)"], { cwd: repo })
    .toString()
    .trim()
    .split("\n");

async function dispatch(harness: Harness, key: string, workspaceMode?: WorkspaceMode) {
  const { task } = await harness.manager("mgr").dispatch({
    repo: "app",
    title: "File an issue",
    instructions: "Open a GitHub issue describing the bug",
    idempotencyKey: `workspace-modes-${key}`,
    ...(workspaceMode ? { workspaceMode } : {}),
  });
  return task;
}

describe("dispatch without a workspace", () => {
  it("runs the worker in its own scratch directory, with no branch or worktree, through review to acceptance", async () => {
    h = await startHarness();
    const repo = await setupRepo(h, "app");
    const queued = await dispatch(h, "full", "none");
    expect(queued.workspaceMode).toBe("none");

    const { task, events } = await waitForState(h, queued.id, "ready_for_review");
    expect(task).toMatchObject({ workspacePath: null, branch: null, baseRef: null });
    expect(task.result?.reported?.summary).toBe("Wrote ocd-fake.txt");
    expect(task.result?.verification).toBeNull();
    const scratch = join(h.paths.scratch, task.id);
    expect(existsSync(join(scratch, "ocd-fake.txt"))).toBe(true);
    expect(events.find((e) => e.type === "workspace.ready")?.data).toEqual({
      mode: "none",
      directory: scratch,
    });
    expect(h.fakeState.prompts[0]).toContain(scratch);
    expect(h.fakeState.prompts[0]).not.toContain("commit");
    expect(readdirSync(h.paths.workspaces, { recursive: true })).toEqual([]);
    expect(branches(repo)).toEqual(["main"]);

    const refused = { code: "no_workspace" };
    await expect(h.human.taskDiff(task.id)).rejects.toMatchObject(refused);
    await expect(h.human.landPlan(task.id)).rejects.toMatchObject(refused);
    await expect(h.human.landTask(task.id, {})).rejects.toMatchObject(refused);
    await expect(h.human.landTask(task.id, { direct: true })).rejects.toMatchObject(refused);
    await expect(h.human.openPullRequest(task.id, {})).rejects.toMatchObject(refused);
    await expect(h.human.takeOverTask(task.id)).rejects.toMatchObject(refused);
    expect((await h.human.inspectTask(task.id)).task.state).toBe("ready_for_review");

    await expect(h.human.acceptTask(task.id)).resolves.toMatchObject({ state: "completed" });
    await expect(h.human.cleanupTask(task.id, true)).resolves.toMatchObject({
      state: "completed",
    });
    expect(branches(repo)).toEqual(["main"]);
    expect(existsSync(join(scratch, "ocd-fake.txt"))).toBe(true);
  });

  it("discarding cancels the task and leaves the repository alone", async () => {
    h = await startHarness();
    const repo = await setupRepo(h, "app");
    const task = await dispatch(h, "discard", "none");
    await waitForState(h, task.id, "ready_for_review");
    await expect(h.human.discardTask(task.id)).resolves.toMatchObject({ state: "cancelled" });
    expect(branches(repo)).toEqual(["main"]);
  });

  it("sends review feedback to the worker without asking it to commit", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const task = await dispatch(h, "changes", "none");
    await waitForState(h, task.id, "ready_for_review");
    await h.human.requestChanges(task.id, "Add reproduction steps");
    await waitForState(h, task.id, "ready_for_review");
    const feedback = h.fakeState.prompts.at(-1)!;
    expect(feedback).toContain("Add reproduction steps");
    expect(feedback).not.toContain("commit");
  });

  it("adopts the session a crash left behind instead of launching a second worker", async () => {
    let crashed = false;
    const crashOnce = (point: CrashPoint) => {
      if (point === "after_session_created" && !crashed) {
        crashed = true;
        throw new SimulatedCrash(point);
      }
    };
    h = await startHarness({ hooks: { at: crashOnce }, fake: { survive: true } });
    await setupRepo(h, "app");
    const task = await dispatch(h, "crash", "none");
    await h.daemon.closed;
    await h.restart({ hooks: {} });
    await waitForState(h, task.id, "ready_for_review");
    expect(h.fakeState.createdCount).toBe(1);
    expect(h.fakeState.promptCount).toBe(1);
  });
});

describe("dispatch workspace mode", () => {
  it("defaults to an isolated worktree on its own branch", async () => {
    h = await startHarness();
    const repo = await setupRepo(h, "app");
    const queued = await dispatch(h, "default");
    expect(queued.workspaceMode).toBe("isolated");
    const { task } = await waitForState(h, queued.id, "ready_for_review");
    expect(existsSync(join(task.workspacePath!, "ocd-fake.txt"))).toBe(true);
    expect(branches(repo)).toEqual(["main", `ocd/${task.id}`]);
  });

  it("is part of what an idempotency key identifies", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    await dispatch(h, "same-key", "none");
    await expect(dispatch(h, "same-key", "isolated")).rejects.toMatchObject({
      code: "idempotency_mismatch",
    });
    await expect(dispatch(h, "same-key", "none")).resolves.toMatchObject({ workspaceMode: "none" });
  });
});
