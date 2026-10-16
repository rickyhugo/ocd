import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMode } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SimulatedCrash } from "./errors.ts";
import type { CrashPoint } from "./supervisor.ts";
import { setupRepo, startHarness, waitForState, type Harness } from "./testkit.ts";
import { githubSlug } from "./workspace.ts";

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
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
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
    const prompt = h.fakeState.prompts[0]!;
    expect(prompt).toContain(scratch);
    expect(prompt).toContain("acme/app");
    expect(prompt).not.toContain(repo);
    expect(prompt).not.toContain("commit");
    expect(prompt).not.toContain("relative/to/repo");
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
    await expect(h.human.mergePullRequest(task.id)).rejects.toMatchObject(refused);
    expect(existsSync(scratch)).toBe(true);
    await expect(h.manager("mgr").cleanupTask(task.id)).resolves.toMatchObject({
      state: "completed",
    });
    expect(existsSync(scratch)).toBe(false);
    const cleaned = (await h.human.inspectTask(task.id)).events.filter(
      (e) => e.type === "workspace.cleaned",
    );
    expect(cleaned.map((e) => e.data)).toEqual([{ scratch, forced: false, actor: "manager" }]);
    await expect(h.human.cleanupTask(task.id, true)).resolves.toMatchObject({
      state: "completed",
    });
    expect(branches(repo)).toEqual(["main"]);
  });

  it("tells the worker when the repository has no GitHub remote, without naming its path", async () => {
    h = await startHarness();
    const repo = await setupRepo(h, "app");
    const upstream = join(h.root, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    execFileSync("git", ["remote", "add", "origin", upstream], { cwd: repo });
    const task = await dispatch(h, "no-github", "none");
    await waitForState(h, task.id, "ready_for_review");
    const prompt = h.fakeState.prompts[0]!;
    expect(prompt).toContain("no GitHub remote");
    expect(prompt).not.toContain(upstream);
    expect(prompt).not.toContain(repo);
  });

  it("discarding cancels the task, removes its scratch directory and leaves the repository alone", async () => {
    h = await startHarness();
    const repo = await setupRepo(h, "app");
    const task = await dispatch(h, "discard", "none");
    await waitForState(h, task.id, "ready_for_review");
    const scratch = join(h.paths.scratch, task.id);
    expect(existsSync(scratch)).toBe(true);
    await expect(h.human.discardTask(task.id)).resolves.toMatchObject({ state: "cancelled" });
    expect(existsSync(scratch)).toBe(false);
    expect(branches(repo)).toEqual(["main"]);
  });

  it("automatic cleanup removes the scratch directory of an old finished task", async () => {
    let now = Date.parse("2026-10-14T10:00:00Z");
    h = await startHarness({
      clock: () => now,
      config: { autoCleanup: { enabled: true, afterHours: 24 } },
    });
    await setupRepo(h, "app");
    const task = await dispatch(h, "auto-cleanup", "none");
    await waitForState(h, task.id, "ready_for_review");
    await h.human.acceptTask(task.id);
    const scratch = join(h.paths.scratch, task.id);
    expect(await h.daemon.supervisor.autoCleanup()).toEqual([]);
    expect(existsSync(scratch)).toBe(true);
    now += 25 * 3_600_000;
    expect(await h.daemon.supervisor.autoCleanup()).toEqual([task.id]);
    expect(existsSync(scratch)).toBe(false);
    expect(await h.daemon.supervisor.autoCleanup()).toEqual([]);
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
    expect(feedback).not.toContain("relative/to/repo");
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

describe("githubSlug", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://x-access-token:secret@github.com/acme/my.app.git", "acme/my.app"],
    ["ssh://git@github.com/acme/app.git", "acme/app"],
    ["git@gitlab.com:acme/app.git", null],
    ["/Users/me/src/app", null],
    ["file:///Users/me/src/github.com/acme/app", null],
  ])("%s -> %s", (url, slug) => {
    expect(githubSlug(url)).toBe(slug);
  });
});
