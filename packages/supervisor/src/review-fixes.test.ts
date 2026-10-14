import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Task } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { RecordingPullRequests } from "./pull-requests.ts";
import {
  declareRepos,
  makeRepo,
  setupRepo,
  startHarness,
  waitForState,
  type Harness,
  type HarnessOptions,
} from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const SLOW = 90_000;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A repo whose origin is a local bare repository, so pushes are real. */
async function setup(options: Partial<HarnessOptions> = {}) {
  const harness = await startHarness(options);
  h = harness;
  const repo = makeRepo(harness.root, "app");
  const origin = join(harness.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  await declareRepos(harness, { app: { path: repo, profile: "fake" } });
  return harness;
}

/** A task ready for review with the worker's file committed. */
async function committedTask(harness: Harness, key: string, commit = true): Promise<Task> {
  const { task } = await harness.manager("mgr").dispatch({
    repo: "app",
    title: "Write the file",
    instructions: "x",
    idempotencyKey: `fixes-${key}`,
  });
  const done = (await waitForState(harness, task.id, "ready_for_review")).task;
  if (commit) {
    git(done.workspacePath!, "add", "-A");
    git(done.workspacePath!, "commit", "-q", "-m", "Write the file");
  }
  return done;
}

describe("merged pull requests keep local work that GitHub did not merge", () => {
  it(
    "keeps the worktree and branch for later commits and binds the merge to the checked head",
    async () => {
      const prs = new RecordingPullRequests();
      const harness = await setup({ pullRequests: prs });
      const task = await committedTask(harness, "later-commit");
      await harness.human.openPullRequest(task.id);
      const url = "https://example.test/pr/1";
      prs.statuses.set(url, { headSha: "a".repeat(40) });
      // Work added after the push, never part of the PR.
      writeFileSync(join(task.workspacePath!, "later.txt"), "later\n");
      git(task.workspacePath!, "add", "-A");
      git(task.workspacePath!, "commit", "-q", "-m", "Later work");

      const r = await harness.human.landTask(task.id);
      expect(prs.merged).toEqual([{ url, method: "squash", matchHead: "a".repeat(40) }]);
      expect(r).toMatchObject({ landed: false, waiting: { code: "worktree_kept" } });
      expect(existsSync(task.workspacePath!)).toBe(true);
      expect(git(task.workspacePath!, "log", "-1", "--format=%s")).toBe("Later work");
      expect(git(task.workspacePath!, "branch", "--show-current")).toBe(task.branch);
      const detail = await harness.human.inspectTask(task.id);
      expect(detail.task.workspacePath).toBe(task.workspacePath);
      expect(detail.events.find((e) => e.type === "pull_request.merged")?.data).toMatchObject({
        worktreeKept: true,
        remoteBranchDeleted: false,
      });
    },
    SLOW,
  );

  it(
    "keeps uncommitted edits too",
    async () => {
      const prs = new RecordingPullRequests();
      const harness = await setup({ pullRequests: prs });
      const task = await committedTask(harness, "dirty");
      await harness.human.openPullRequest(task.id);
      writeFileSync(join(task.workspacePath!, "wip.txt"), "unsaved\n");
      const r = await harness.human.landTask(task.id);
      expect(r.waiting).toMatchObject({ code: "worktree_kept" });
      expect(r.waiting?.message).toContain("uncommitted");
      expect(existsSync(join(task.workspacePath!, "wip.txt"))).toBe(true);
    },
    SLOW,
  );
});

describe("landing through a pull request", () => {
  it(
    "does not call an open PR landed just because the worktree is gone",
    async () => {
      const prs = new RecordingPullRequests();
      const harness = await setup({ pullRequests: prs });
      const task = await committedTask(harness, "open-pr");
      await harness.human.openPullRequest(task.id);
      await harness.human.acceptTask(task.id);
      await harness.human.cleanupTask(task.id, true);

      const waiting = await harness.human.landTask(task.id);
      expect(waiting).toMatchObject({ landed: false, waiting: { code: "pr_not_merged" } });
      prs.merged.push({ url: "https://example.test/pr/1", method: "squash" });
      await expect(harness.human.landTask(task.id)).resolves.toMatchObject({ landed: true });
    },
    SLOW,
  );

  it(
    "refuses a dirty worktree before accepting, so the task stays steerable",
    async () => {
      const prs = new RecordingPullRequests();
      const harness = await setup({ pullRequests: prs });
      const task = await committedTask(harness, "dirty-refusal", false);
      await expect(harness.human.landTask(task.id)).rejects.toMatchObject({
        code: "workspace_dirty",
      });
      expect((await harness.human.inspectTask(task.id)).task.state).toBe("ready_for_review");
      await expect(harness.human.sendToWorker(task.id, "carry on")).resolves.toBeDefined();
    },
    SLOW,
  );
});

describe("stale land confirmations", () => {
  it(
    "are settled when the push is confirmed directly by the human",
    async () => {
      const harness = await setup();
      const task = await committedTask(harness, "stale-land");
      const asked = await harness.manager("mgr").landTask(task.id, { direct: true });
      const plan = await harness.human.landPlan(task.id);
      await harness.human.landTask(task.id, { direct: true, confirm: plan.head });
      const [item] = (await harness.human.listAttention({ taskId: task.id })).filter(
        (a) => a.id === asked.attentionId,
      );
      expect(item).toMatchObject({ kind: "land", status: "expired" });
    },
    SLOW,
  );

  it(
    "are settled by cleanup",
    async () => {
      const harness = await setup();
      const task = await committedTask(harness, "cleanup-land");
      const asked = await harness.manager("mgr").landTask(task.id, { direct: true });
      await harness.human.acceptTask(task.id);
      await harness.human.cleanupTask(task.id, true);
      const items = await harness.human.listAttention({ taskId: task.id });
      expect(items.find((a) => a.id === asked.attentionId)?.status).toBe("expired");
    },
    SLOW,
  );
});

describe("request changes", () => {
  it(
    "numbers concurrent requests under the task lock: one round, one refusal",
    async () => {
      const harness = await setup();
      const task = await committedTask(harness, "rounds");
      const results = await Promise.allSettled([
        harness.human.requestChanges(task.id, "first"),
        harness.human.requestChanges(task.id, "second"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "not_reviewable" });
      const rounds = (await harness.human.inspectTask(task.id)).events.filter(
        (e) => e.type === "review.changes_requested",
      );
      expect(rounds).toHaveLength(1);
    },
    SLOW,
  );
});

describe("auto-approve", () => {
  it(
    "does not leave an approved record when the harness reply fails; the human can still answer",
    async () => {
      const harness = await startHarness({
        config: {
          profiles: { open: { harness: "fake", model: "fake/model", permissionPolicy: "allow" } },
        },
      });
      h = harness;
      const repo = makeRepo(harness.root, "app");
      await declareRepos(harness, { app: { path: repo, profile: "open" } });
      const original = harness.adapter.reply.bind(harness.adapter);
      let failed = false;
      harness.adapter.reply = async (ref, id, reply) => {
        if (!failed) {
          failed = true;
          throw new Error("harness unreachable");
        }
        return original(ref, id, reply);
      };
      const { task } = await harness.human.dispatch({
        repo: "app",
        title: "Needs permission",
        instructions: "go [fake:permission]",
        idempotencyKey: "fixes-autoapprove",
      });
      await waitForState(harness, task.id, "blocked");
      const items = (await harness.human.listAttention({ taskId: task.id })).filter(
        (a) => a.kind === "permission",
      );
      expect(items.some((a) => a.status === "resolved")).toBe(false);
      expect(items.find((a) => a.status === "expired")).toBeDefined();
      const open = items.find((a) => a.status === "open")!;
      expect(open.reason).toContain("auto-approve failed");
      await harness.human.resolveAttention(open.id, { type: "approve" });
      await waitForState(harness, task.id, "ready_for_review");
    },
    SLOW,
  );
});

describe("manual mode", () => {
  it(
    "clears finishedAt when the task is given back to the worker",
    async () => {
      const harness = await setup({ fake: { stepDelayMs: 300 } });
      const task = await committedTask(harness, "giveback");
      expect((await harness.human.inspectTask(task.id)).task.finishedAt).not.toBeNull();
      await harness.human.takeOverTask(task.id);
      const back = await harness.human.giveBackTask(task.id, { mode: "continue" });
      expect(back.state).toBe("running");
      expect(back.finishedAt).toBeNull();
    },
    SLOW,
  );
});

describe("worker report text", () => {
  it(
    "is redacted before it is stored or published in a pull request",
    async () => {
      const prs = new RecordingPullRequests();
      const report = {
        summary: "Done; token=abcdef0123456789 was used",
        changedFiles: ["ocd-fake.txt"],
        tests: [{ command: "run `rm -rf x`\nnow", outcome: "passed" }],
        unresolved: ["password: hunter2hunter2 still set"],
      };
      const harness = await setup({
        pullRequests: prs,
        fake: {
          script: () => [
            { type: "write", file: "ocd-fake.txt", content: "x\n" },
            { type: "reply", text: `\`\`\`ocd-report\n${JSON.stringify(report)}\n\`\`\`` },
          ],
        },
      });
      const task = await committedTask(harness, "redact");
      const stored = JSON.stringify((await harness.human.inspectTask(task.id)).task.result);
      expect(stored).not.toContain("abcdef0123456789");
      expect(stored).not.toContain("hunter2hunter2");
      await harness.human.openPullRequest(task.id);
      const body = prs.created[0]!.body;
      expect(body).not.toContain("abcdef0123456789");
      expect(body).not.toContain("hunter2hunter2");
      expect(body).toContain("[REDACTED]");
      expect(body).toContain("- passed: `run 'rm -rf x' now`");
    },
    SLOW,
  );
});

describe("cleanup", () => {
  it(
    "maps a git failure to a conflict instead of a 500",
    async () => {
      const harness = await setup();
      const task = await committedTask(harness, "locked");
      await harness.human.acceptTask(task.id);
      // A locked worktree cannot be removed with a single --force.
      git(task.workspacePath!, "worktree", "lock", task.workspacePath!);
      await expect(harness.human.cleanupTask(task.id, true)).rejects.toMatchObject({
        code: "cleanup_failed",
      });
      expect(existsSync(task.workspacePath!)).toBe(true);
    },
    SLOW,
  );
});

describe("automatic cleanup", () => {
  it("removes old finished worktrees without forcing, and keeps ones whose work would be lost", async () => {
    let now = Date.parse("2026-10-14T10:00:00Z");
    const harness = await startHarness({
      clock: () => now,
      config: { autoCleanup: { enabled: true, afterHours: 24 } },
    });
    try {
      await setupRepo(harness, "app");
      const dispatchOne = async (key: string) => {
        const { task } = await harness.manager("mgr").dispatch({
          repo: "app",
          title: key,
          instructions: "x",
          idempotencyKey: `auto-cleanup-${key}`,
        });
        return (await waitForState(harness, task.id, "ready_for_review")).task;
      };
      // Nothing of value: the worker's file is discarded with the cancel.
      const empty = await dispatchOne("empty");
      execFileSync("git", ["checkout", "--", "."], { cwd: empty.workspacePath! });
      execFileSync("git", ["clean", "-fdq"], { cwd: empty.workspacePath! });
      await harness.human.cancelTask(empty.id);
      // A commit that exists nowhere else.
      const work = await dispatchOne("work");
      execFileSync("git", ["add", "-A"], { cwd: work.workspacePath! });
      execFileSync("git", ["commit", "-qm", "unlanded"], { cwd: work.workspacePath! });
      await harness.human.cancelTask(work.id);

      // Too recent: nothing happens.
      expect(await harness.daemon.supervisor.autoCleanup()).toEqual([]);
      now += 25 * 3_600_000;
      expect(await harness.daemon.supervisor.autoCleanup()).toEqual([empty.id]);
      const cleaned = await harness.human.inspectTask(empty.id);
      expect(cleaned.task.workspacePath).toBeNull();
      expect(cleaned.events.find((e) => e.type === "workspace.cleaned")?.data).toMatchObject({
        forced: false,
        auto: true,
      });
      expect((await harness.human.inspectTask(work.id)).task.workspacePath).not.toBeNull();
      // Kept ones are not retried every hour.
      expect(await harness.daemon.supervisor.autoCleanup()).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
