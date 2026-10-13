import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeReport, type FakeScript } from "@ocd/adapters";
import type { BranchSyncMode, Task } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SimulatedCrash } from "./errors.ts";
import type { CrashPoint } from "./supervisor.ts";
import {
  declareRepos,
  makeRepo,
  startHarness,
  waitFor,
  waitForState,
  type Harness,
  type HarnessOptions,
} from "./testkit.ts";

// The branch-sync watchdog against disposable repositories and fake workers.

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function commit(cwd: string, file: string, content: string, message = `change ${file}`): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** `[hang]` keeps the worker busy; `[error]` fails the first attempt; otherwise it reports at once. */
const script: FakeScript = (prompt) => {
  if (prompt.includes("[hang]")) return [{ type: "hang" }];
  if (prompt.includes("[error]") && !prompt.includes("earlier attempt"))
    return [{ type: "error", message: "boom" }];
  return [{ type: "reply", text: fakeReport("done", []) }];
};

async function setup(
  mode: BranchSyncMode | undefined,
  options: Partial<HarnessOptions> = {},
  repo: { baseRef?: string } = { baseRef: "main" },
): Promise<string> {
  h = await startHarness({
    fake: { script },
    ...options,
    config: { concurrency: 4, ...options.config },
  });
  const path = makeRepo(h.root, "app");
  await declareRepos(h, {
    app: { path, profile: "fake", ...repo, ...(mode ? { branchSync: mode } : {}) },
  });
  return path;
}

async function dispatch(instructions: string, key: string): Promise<Task> {
  const { task } = await h!.human.dispatch({
    repo: "app",
    title: `Task ${key}`,
    instructions,
    idempotencyKey: `branch-sync-${key}`,
  });
  return task;
}

async function reviewed(key: string): Promise<Task> {
  const task = await dispatch("work", key);
  return (await waitForState(h!, task.id, "ready_for_review")).task;
}

/** A task waiting to relaunch in its existing worktree (dispatch is paused). */
async function queuedWithWorktree(key: string): Promise<Task> {
  const task = await dispatch("work [error]", key);
  await waitForState(h!, task.id, "failed");
  await h!.human.pause();
  await h!.human.resumeTask(task.id, "relaunch");
  const d = await h!.human.inspectTask(task.id);
  expect(d.task.state).toBe("queued");
  expect(d.task.workspacePath).toBeTruthy();
  return d.task;
}

async function sync(taskId: string): Promise<Task> {
  await h!.daemon.supervisor.syncBranches();
  return (await h!.human.inspectTask(taskId)).task;
}

async function events(taskId: string, type: string) {
  return (await h!.human.inspectTask(taskId)).events.filter((e) => e.type === type);
}

async function syncAttention(taskId: string) {
  return (await h!.human.listAttention({ taskId })).filter((a) =>
    a.reason.includes("would conflict"),
  );
}

describe("branch sync: detection", () => {
  it("is off by default: nothing is checked", async () => {
    const repo = await setup(undefined);
    const task = await reviewed("off");
    commit(repo, "base.txt", "base\n");
    expect((await sync(task.id)).branchSync).toBeNull();
  });

  it("runs on its own timer when enabled", async () => {
    await setup("detect", { config: { branchSync: { intervalMs: 100 } } });
    const task = await reviewed("timer");
    const found = await waitFor(
      () => h!.human.inspectTask(task.id),
      (d) => d.task.branchSync?.state === "current",
    );
    expect(found.task.branchSync?.reason).toMatch(/Up to date with main/);
  });

  it("detect mode reports drift and conflicts once, and changes nothing", async () => {
    const repo = await setup("detect");
    const task = await queuedWithWorktree("detect");
    const ws = task.workspacePath!;
    const head = commit(ws, "README.md", "task version\n");

    commit(repo, "base.txt", "base\n");
    let t = await sync(task.id);
    expect(t.branchSync).toMatchObject({ state: "behind", behind: 1, head, baseRef: "main" });
    expect(t.branchSync?.reason).toMatch(/detect-only/);

    commit(repo, "README.md", "base version\n");
    for (let i = 0; i < 3; i += 1) t = await sync(task.id);
    expect(t.branchSync).toMatchObject({
      state: "conflict",
      behind: 2,
      conflictFiles: ["README.md"],
    });
    expect(git(ws, "rev-parse", "HEAD")).toBe(head);
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(t.baseRef).toBe(task.baseRef);
    const items = await syncAttention(task.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "decision", status: "open", resolvableBy: "manager" });
    expect(await events(task.id, "branch_sync.conflict")).toHaveLength(1);
  });

  it("refuses bases it must not track: unset, a task branch, or rewritten history", async () => {
    const repo = await setup("refresh", {}, {});
    const sibling = await reviewed("sibling");
    const task = await queuedWithWorktree("bases");
    commit(repo, "base.txt", "base\n");
    expect((await sync(task.id)).branchSync?.reason).toMatch(/baseRef is not set/);

    await declareRepos(h!, {
      app: { path: repo, profile: "fake", branchSync: "refresh", baseRef: `ocd/${sibling.id}` },
    });
    let t = await sync(task.id);
    expect(t.branchSync?.state).toBe("skipped");
    expect(t.branchSync?.reason).toMatch(/is an OCD task branch/);

    git(repo, "checkout", "-q", "--orphan", "rewritten");
    commit(repo, "other.txt", "unrelated\n");
    git(repo, "checkout", "-q", "main");
    await declareRepos(h!, {
      app: { path: repo, profile: "fake", branchSync: "refresh", baseRef: "rewritten" },
    });
    t = await sync(task.id);
    expect(t.branchSync?.state).toBe("skipped");
    expect(t.branchSync?.reason).toMatch(/not in rewritten any more/);
    expect(git(task.workspacePath!, "log", "--format=%H", "-1")).toBe(task.baseRef);
  });
});

describe("branch sync: refresh", () => {
  it("fast-forwards, then merges, a clean queued branch; never pushes", async () => {
    const repo = await setup("refresh");
    const origin = join(h!.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "-u", "origin", "main");
    const remoteBefore = git(repo, "ls-remote", "origin");

    const task = await queuedWithWorktree("refresh");
    const ws = task.workspacePath!;
    const tip1 = commit(repo, "base.txt", "base\n");
    let t = await sync(task.id);
    expect(git(ws, "rev-parse", "HEAD")).toBe(tip1);
    expect(t.baseRef).toBe(tip1);
    expect(t.branchSync).toMatchObject({ state: "current", behind: 0 });
    expect(t.branchSync?.lastRefresh).toMatchObject({
      method: "fast-forward",
      trigger: "periodic",
    });

    const own = commit(ws, "task.txt", "task\n");
    const tip2 = commit(repo, "base2.txt", "base 2\n");
    t = await sync(task.id);
    expect(git(ws, "rev-parse", "HEAD^1")).toBe(own);
    expect(git(ws, "rev-parse", "HEAD^2")).toBe(tip2);
    expect(git(ws, "log", "-1", "--format=%s")).toBe(`Merge main into ocd/${task.id}`);
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(t.baseRef).toBe(tip2);
    expect(t.branchSync?.lastRefresh).toMatchObject({ method: "merge", baseTip: tip2 });
    // Verification against the moved base still shows only the task's own change.
    expect(git(ws, "diff", "--name-only", `${t.baseRef}...HEAD`)).toBe("task.txt");
    expect(await events(task.id, "branch_sync.refreshed")).toHaveLength(2);
    // main itself and the remote are untouched.
    expect(git(repo, "rev-parse", "main")).toBe(tip2);
    expect(git(repo, "ls-remote", "origin")).toBe(remoteBefore);
  });

  it("refreshes at the launch boundary and tells the worker", async () => {
    const repo = await setup("refresh");
    const task = await queuedWithWorktree("launch");
    const tip = commit(repo, "base.txt", "base\n");
    await h!.human.resume();
    const done = await waitForState(h!, task.id, "ready_for_review");
    expect(git(task.workspacePath!, "rev-parse", "HEAD")).toBe(tip);
    expect(done.task.branchSync?.lastRefresh).toMatchObject({ trigger: "launch" });
    expect(h!.fakeState.prompts.at(-1)).toMatch(
      new RegExp(`OCD brought ocd/${task.id} up to date with main`),
    );
  });

  it("leaves active, manual, reviewed and uncertain tasks alone and says until when", async () => {
    const repo = await setup("refresh");
    const review = await reviewed("review");
    const running = await dispatch("work [hang]", "running");
    await waitForState(h!, running.id, "running");
    const failed = await dispatch("work [error]", "failed");
    await waitForState(h!, failed.id, "failed");
    const manual = await dispatch("work [hang]", "manual");
    await waitForState(h!, manual.id, "running");
    await h!.human.takeOverTask(manual.id);
    const tasks = [review, running, failed, manual];
    const heads = await Promise.all(
      tasks.map(async (t) =>
        git((await h!.human.inspectTask(t.id)).task.workspacePath!, "rev-parse", "HEAD"),
      ),
    );

    commit(repo, "base.txt", "base\n");
    await h!.daemon.supervisor.syncBranches();
    const reasons: string[] = [];
    for (const [i, t] of tasks.entries()) {
      const d = await h!.human.inspectTask(t.id);
      expect(d.task.branchSync?.state).toBe("behind");
      expect(git(d.task.workspacePath!, "rev-parse", "HEAD")).toBe(heads[i]);
      reasons.push(d.task.branchSync!.reason);
    }
    expect(reasons[0]).toMatch(/ready for review, so it is not changed under the reviewer/);
    expect(reasons[1]).toMatch(/a worker is active/);
    expect(reasons[2]).toMatch(/the last run is uncertain/);
    expect(reasons[3]).toMatch(/in manual mode/);
    // The review's independent verification is untouched.
    expect((await h!.human.inspectTask(review.id)).task.result).toEqual(review.result);
  });

  it("skips dirty worktrees, ignored files it would overwrite, and git operations in progress", async () => {
    const repo = await setup("refresh");
    commit(repo, ".gitignore", "local.cfg\n");
    const task = await queuedWithWorktree("dirty");
    const ws = task.workspacePath!;
    const head = git(ws, "rev-parse", "HEAD");
    writeFileSync(join(ws, "local.cfg"), "mine\n");
    writeFileSync(join(repo, "local.cfg"), "theirs\n");
    git(repo, "add", "-f", "local.cfg");
    git(repo, "commit", "-q", "-m", "track local.cfg");

    let t = await sync(task.id);
    expect(t.branchSync?.reason).toMatch(/would overwrite ignored file\(s\) local.cfg/);

    writeFileSync(join(ws, "scratch.txt"), "notes\n");
    t = await sync(task.id);
    expect(t.branchSync?.state).toBe("behind");
    expect(t.branchSync?.reason).toMatch(/1 uncommitted or untracked file\(s\) \(scratch.txt\)/);

    rmSync(join(ws, "scratch.txt"));
    const lock = join(git(ws, "rev-parse", "--absolute-git-dir"), "index.lock");
    writeFileSync(lock, "");
    t = await sync(task.id);
    expect(t.branchSync?.state).toBe("skipped");
    expect(t.branchSync?.reason).toMatch(/git operation is in progress .*index.lock/);
    expect(git(ws, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(ws, "local.cfg"), "utf8")).toBe("mine\n");

    rmSync(lock);
    rmSync(join(ws, "local.cfg"));
    t = await sync(task.id);
    expect(t.branchSync?.state).toBe("current");
    expect(readFileSync(join(ws, "local.cfg"), "utf8")).toBe("theirs\n");
  });

  it("never applies a conflicting update and reports each conflict once", async () => {
    const repo = await setup("refresh");
    const task = await queuedWithWorktree("conflict");
    const ws = task.workspacePath!;
    const head = commit(ws, "README.md", "task version\n");
    commit(repo, "README.md", "base version\n");

    for (let i = 0; i < 3; i += 1) await sync(task.id);
    expect(git(ws, "rev-parse", "HEAD")).toBe(head);
    expect(git(ws, "status", "--porcelain")).toBe("");
    expect(existsSync(join(git(ws, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(false);
    let items = await syncAttention(task.id);
    expect(items).toHaveLength(1);

    // Acknowledged: the same conflict is not raised again.
    await h!.manager("mgr").resolveAttention(items[0]!.id, { type: "acknowledge" });
    await sync(task.id);
    expect((await syncAttention(task.id)).filter((a) => a.status === "open")).toHaveLength(0);

    // The base moved and still conflicts: one new report.
    commit(repo, "base.txt", "base\n");
    await sync(task.id);
    await sync(task.id);
    items = await syncAttention(task.id);
    expect(items.filter((a) => a.status === "open")).toHaveLength(1);
    expect(await events(task.id, "branch_sync.conflict")).toHaveLength(2);

    // Once the branch contains the base, the report is settled.
    git(ws, "merge", "-q", "main", "-X", "ours", "-m", "resolve by hand");
    const t = await sync(task.id);
    expect(t.branchSync?.state).toBe("current");
    expect((await syncAttention(task.id)).filter((a) => a.status === "open")).toHaveLength(0);
  });
});

describe("branch sync: races, review and recovery", () => {
  it("re-checks just before writing: a moved branch or changed state is left alone", async () => {
    let race: (() => void) | null = null;
    const repo = await setup("refresh", {
      hooks: {
        at: (point: CrashPoint) => {
          if (point === "before_branch_sync_recheck" && race) {
            const act = race;
            race = null;
            act();
          }
        },
      },
    });
    const task = await queuedWithWorktree("race");
    const ws = task.workspacePath!;
    commit(repo, "base.txt", "base\n");

    let moved = "";
    race = () => {
      moved = commit(ws, "late.txt", "late\n");
    };
    let t = await sync(task.id);
    expect(t.branchSync?.reason).toMatch(/the branch moved while checking/);
    expect(git(ws, "rev-parse", "HEAD")).toBe(moved);

    race = () => {
      h!.daemon.store.transition(task.id, "cancelled");
    };
    t = await sync(task.id);
    expect(t.branchSync?.reason).toMatch(/the task became cancelled/);
    expect(git(ws, "rev-parse", "HEAD")).toBe(moved);
    expect(await events(task.id, "branch_sync.intent")).toHaveLength(0);
  });

  it("a follow-up refreshes a reviewed branch first; the worker re-reports and OCD re-verifies", async () => {
    const repo = await setup("refresh");
    const task = await reviewed("follow-up");
    const ws = task.workspacePath!;
    commit(ws, "task.txt", "task\n");
    const tip = commit(repo, "base.txt", "base\n");
    let t = await sync(task.id);
    expect(t.branchSync?.state).toBe("behind");
    expect(git(ws, "rev-parse", "HEAD^{tree}")).not.toBe(git(repo, "rev-parse", "main^{tree}"));

    await h!.human.sendToWorker(task.id, "Polish it");
    const done = await waitFor(
      () => h!.human.inspectTask(task.id),
      (d) =>
        d.task.state === "ready_for_review" &&
        d.task.result?.verification?.changedFiles.includes("task.txt") === true,
    );
    expect(git(ws, "rev-parse", "HEAD^2")).toBe(tip);
    expect(done.task.branchSync?.lastRefresh).toMatchObject({ trigger: "follow_up" });
    expect(done.task.result?.verification?.changedFiles).toEqual(["task.txt"]);
    expect(h!.fakeState.prompts.at(-1)).toMatch(/^Before this instruction OCD brought/);

    // Accepted work is never touched again.
    await h!.human.acceptTask(task.id);
    const before = (await h!.human.inspectTask(task.id)).task.branchSync;
    commit(repo, "base2.txt", "base 2\n");
    t = await sync(task.id);
    expect(t.branchSync).toEqual(before);
  });

  it("finishes the record after a crash between the git write and its bookkeeping", async () => {
    let armed = true;
    const repo = await setup("refresh", {
      hooks: {
        at: (point: CrashPoint) => {
          if (point === "after_branch_sync_write" && armed) {
            armed = false;
            throw new SimulatedCrash(point);
          }
        },
      },
    });
    const task = await queuedWithWorktree("crash");
    const tip = commit(repo, "base.txt", "base\n");
    await h!.daemon.supervisor.syncBranches();
    await h!.daemon.closed;
    // The write happened; the record still holds the intent.
    expect(git(task.workspacePath!, "rev-parse", "HEAD")).toBe(tip);

    await h!.restart({ hooks: {} });
    const pending = (await h!.human.inspectTask(task.id)).task;
    expect(pending.branchSync?.intent).toMatchObject({ to: tip });
    expect(pending.baseRef).toBe(task.baseRef);
    const t = await sync(task.id);
    expect(t.branchSync).toMatchObject({ state: "current", intent: null });
    expect(t.branchSync?.lastRefresh).toMatchObject({ trigger: "recovered", to: tip });
    expect(t.baseRef).toBe(tip);
    expect(t.state).toBe("queued");

    // Stopping waits for a pass in flight instead of cutting a git write short.
    commit(repo, "base2.txt", "base 2\n");
    const pass = h!.daemon.supervisor.syncBranches();
    await h!.daemon.stop();
    await pass;
  });
});
