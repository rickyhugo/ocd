import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Task } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  RecordingPullRequests,
  declareRepos,
  makeRepo,
  startHarness,
  waitFor,
  waitForState,
  type Harness,
  type HarnessOptions,
} from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

interface Setup {
  h: Harness;
  repo: string;
  origin: string;
  /** A second clone, standing in for someone else pushing to origin. */
  other: string;
}

async function setup(options: Partial<HarnessOptions> = {}): Promise<Setup> {
  const harness = await startHarness(options);
  h = harness;
  const repo = makeRepo(harness.root, "app");
  const origin = join(harness.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  const other = join(harness.root, "other");
  execFileSync("git", ["clone", "-q", origin, other]);
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "user.name", "Other");
  await declareRepos(harness, { app: { path: repo, profile: "fake" } });
  return { h: harness, repo, origin, other };
}

/** A task ready for review whose worker change is committed in two commits. */
async function finishedTask(s: Setup, key: string): Promise<Task> {
  const { task } = await s.h.manager("mgr").dispatch({
    repo: "app",
    title: "Write the file",
    instructions: "x",
    idempotencyKey: `land-test-${key}`,
  });
  const done = (await waitForState(s.h, task.id, "ready_for_review")).task;
  const ws = done.workspacePath!;
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "Write the file");
  writeFileSync(join(ws, "second.txt"), "two\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "Add a second file");
  return done;
}

/** Someone else pushes an unrelated commit to origin/main. */
function pushElsewhere(s: Setup, file = "elsewhere.txt", content = "else\n"): string {
  writeFileSync(join(s.other, file), content);
  git(s.other, "add", "-A");
  git(s.other, "commit", "-q", "-m", `Elsewhere: ${file}`);
  git(s.other, "push", "-q", "origin", "main");
  return git(s.other, "rev-parse", "HEAD");
}

const originLog = (s: Setup, n = 5) =>
  git(s.origin, "log", "-n", String(n), "--format=%s|%an|%P", "main").split("\n");

describe("landing directly on the base branch", () => {
  it("pushes one squashed commit on top of the moved base only after the human confirms", async () => {
    const s = await setup();
    const task = await finishedTask(s, "squash");
    const before = pushElsewhere(s);

    const plan = await s.h.human.landPlan(task.id);
    expect(plan).toMatchObject({ base: "main", method: "squash", dirty: false, blocker: null });
    expect(plan.commits.map((c) => c.subject)).toEqual(["Write the file", "Add a second file"]);
    expect(plan.files).toEqual(["ocd-fake.txt", "second.txt"]);

    await expect(s.h.human.landTask(task.id, { direct: true })).rejects.toMatchObject({
      code: "confirmation_required",
    });
    await expect(
      s.h.human.landTask(task.id, { direct: true, confirm: "0000000" }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(git(s.origin, "rev-parse", "main")).toBe(before);

    const r = await s.h.human.landTask(task.id, { direct: true, confirm: plan.head });
    expect(r.landed).toBe(true);
    expect(r.steps[0]).toBe("accepted");
    expect(git(s.origin, "rev-parse", "main")).toBe(r.commit);
    const [top] = originLog(s);
    expect(top).toBe(`Write the file|OCD Test|${before}`);
    expect(git(s.origin, "show", "main:second.txt")).toBe("two");
    expect(git(s.origin, "show", `main:elsewhere.txt`)).toBe("else");

    expect(r.task).toMatchObject({ state: "completed", workspacePath: null });
    expect(existsSync(task.workspacePath!)).toBe(false);
    expect(git(s.repo, "branch", "--list", task.branch!)).toBe("");
    const landed = (await s.h.human.inspectTask(task.id)).events.find(
      (e) => e.type === "task.landed",
    );
    expect(landed?.data).toMatchObject({ via: "direct", method: "squash", commit: r.commit });
    await waitFor(
      () => s.h.managerChannel.sent,
      (sent) => sent.some((w) => w.text.includes("[landed]")),
    );
  });

  it("replays each commit for rebase and makes a merge commit for merge", async () => {
    const rebase = await setup({ config: { mergeMethod: "rebase" } });
    const a = await finishedTask(rebase, "rebase");
    const base = pushElsewhere(rebase);
    const planA = await rebase.h.human.landPlan(a.id);
    expect(planA.method).toBe("rebase");
    await rebase.h.human.landTask(a.id, { direct: true, confirm: planA.head });
    expect(originLog(rebase, 3).map((l) => l.split("|").slice(0, 2).join("|"))).toEqual([
      "Add a second file|OCD Test",
      "Write the file|OCD Test",
      `Elsewhere: elsewhere.txt|Other`,
    ]);
    expect(originLog(rebase, 2)[1]!.split("|")[2]).toBe(base);
    await h!.cleanup();
    h = null;

    const merge = await setup({ config: { repos: {}, mergeMethod: "squash" } });
    await declareRepos(merge.h, {
      app: { path: merge.repo, profile: "fake", mergeMethod: "merge" },
    });
    const b = await finishedTask(merge, "merge");
    pushElsewhere(merge);
    const planB = await merge.h.human.landPlan(b.id);
    expect(planB.method).toBe("merge");
    await merge.h.human.landTask(b.id, { direct: true, confirm: planB.head });
    const [top] = originLog(merge);
    expect(top!.startsWith(`Merge OCD task ${b.id}: Write the file|`)).toBe(true);
    expect(top!.split("|")[2]!.split(" ")).toHaveLength(2);
  });

  it("refuses dirty worktrees, conflicts and existing pull requests without pushing", async () => {
    const prs = new RecordingPullRequests();
    const s = await setup({ pullRequests: prs });
    const task = await finishedTask(s, "refuse");

    writeFileSync(join(task.workspacePath!, "loose.txt"), "uncommitted\n");
    await expect(s.h.human.landPlan(task.id)).resolves.toMatchObject({
      dirty: true,
      blocker: { code: "workspace_dirty" },
    });
    await expect(
      s.h.human.landTask(task.id, { direct: true, confirm: "x".repeat(40) }),
    ).rejects.toMatchObject({ code: "workspace_dirty" });
    git(task.workspacePath!, "add", "-A");
    git(task.workspacePath!, "commit", "-q", "-m", "loose");

    const before = pushElsewhere(s, "second.txt", "conflicting\n");
    const plan = await s.h.human.landPlan(task.id);
    await expect(
      s.h.human.landTask(task.id, { direct: true, confirm: plan.head }),
    ).rejects.toMatchObject({ code: "land_conflict" });
    expect(git(s.origin, "rev-parse", "main")).toBe(before);
    const failed = (await s.h.human.inspectTask(task.id)).events.find(
      (e) => e.type === "land.failed",
    );
    expect(failed?.data).toMatchObject({ code: "land_conflict" });
    expect((await s.h.human.inspectTask(task.id)).task.state).toBe("ready_for_review");

    await s.h.human.openPullRequest(task.id);
    await expect(s.h.human.landPlan(task.id)).resolves.toMatchObject({
      pullRequestUrl: "https://example.test/pr/1",
    });
    await expect(
      s.h.human.landTask(task.id, { direct: true, confirm: plan.head }),
    ).rejects.toMatchObject({ code: "has_pull_request" });
  });

  it("lets the manager only ask: the human confirms or declines in the inbox", async () => {
    const s = await setup();
    const task = await finishedTask(s, "manager");
    const asked = await s.h.manager("mgr").landTask(task.id, { direct: true });
    expect(asked).toMatchObject({
      landed: false,
      waiting: { code: "confirmation_requested" },
    });
    const again = await s.h.manager("mgr").landTask(task.id, { direct: true });
    expect(again.attentionId).toBe(asked.attentionId);
    const [item] = (await s.h.human.listAttention({ status: "open" })).filter(
      (a) => a.kind === "land",
    );
    expect(item).toMatchObject({ id: asked.attentionId, resolvableBy: "human" });
    expect(item!.reason).toContain("to origin/main (squash)");
    await expect(
      s.h.manager("mgr").resolveAttention(item!.id, { type: "approve" }),
    ).rejects.toMatchObject({ code: "human_only" });

    // The branch moved after the request: approving refuses, nothing is pushed.
    const origin = git(s.origin, "rev-parse", "main");
    writeFileSync(join(task.workspacePath!, "late.txt"), "late\n");
    git(task.workspacePath!, "add", "-A");
    git(task.workspacePath!, "commit", "-q", "-m", "late");
    await expect(s.h.human.resolveAttention(item!.id, { type: "approve" })).rejects.toMatchObject({
      code: "plan_changed",
    });
    expect(git(s.origin, "rev-parse", "main")).toBe(origin);
    await s.h.human.resolveAttention(item!.id, { type: "deny", message: "not yet" });
    await waitFor(
      () => s.h.managerChannel.sent,
      (sent) => sent.some((w) => w.text.includes("declined pushing")),
    );

    const fresh = await s.h.manager("mgr").landTask(task.id, { direct: true });
    expect(fresh.attentionId).not.toBe(asked.attentionId);
    await s.h.human.resolveAttention(fresh.attentionId!, { type: "approve" });
    const after = await s.h.human.inspectTask(task.id);
    expect(after.task).toMatchObject({ state: "completed", workspacePath: null });
    expect(after.events.find((e) => e.type === "task.landed")?.data).toMatchObject({
      attention: fresh.attentionId,
      actor: "human",
    });
    expect(originLog(s, 1)[0]!.startsWith("Write the file|")).toBe(true);
  });
});

describe("landing through a pull request", () => {
  it("accepts, opens the PR, waits on checks, and finishes on the next run", async () => {
    const prs = new RecordingPullRequests();
    const s = await setup({ pullRequests: prs });
    const task = await finishedTask(s, "pr");
    prs.statuses.set("https://example.test/pr/1", { pendingChecks: ["ci"] });

    const first = await s.h.manager("mgr").landTask(task.id);
    expect(first).toMatchObject({
      landed: false,
      steps: ["accepted", "opened https://example.test/pr/1"],
      waiting: { code: "pr_checks_pending" },
    });
    expect(first.task.state).toBe("completed");

    prs.statuses.delete("https://example.test/pr/1");
    const second = await s.h.manager("mgr").landTask(task.id);
    expect(second).toMatchObject({ landed: true, waiting: null });
    expect(prs.created).toHaveLength(1);
    expect(prs.merged).toEqual([{ url: "https://example.test/pr/1", method: "squash" }]);
    expect(second.task.workspacePath).toBeNull();

    await expect(s.h.manager("mgr").landTask(task.id)).resolves.toMatchObject({
      landed: true,
      steps: [],
    });
  });

  it("refuses before accepting when pull requests are off", async () => {
    const s = await setup();
    const task = await finishedTask(s, "no-github");
    await expect(s.h.human.landTask(task.id)).rejects.toMatchObject({
      code: "pr_unavailable",
      message: expect.stringContaining("--direct"),
    });
    expect((await s.h.human.inspectTask(task.id)).task.state).toBe("ready_for_review");
  });
});

describe("cleanup and discard", () => {
  it("counts a squash-merged branch as landed; refuses one whose work is nowhere else", async () => {
    const s = await setup();
    const kept = await finishedTask(s, "kept");
    await s.h.human.acceptTask(kept.id);
    await expect(s.h.human.cleanupTask(kept.id)).rejects.toMatchObject({
      code: "unmerged_commits",
    });

    // As GitHub's squash merge would: the same changes as one new commit on main.
    git(s.other, "pull", "-q");
    git(s.other, "fetch", "-q", s.repo, kept.branch!);
    git(s.other, "merge", "-q", "--squash", "FETCH_HEAD");
    git(s.other, "commit", "-q", "-m", "Squashed");
    git(s.other, "push", "-q", "origin", "main");

    const cleaned = await s.h.human.cleanupTask(kept.id);
    expect(cleaned.workspacePath).toBeNull();
    const event = (await s.h.human.inspectTask(kept.id)).events.find(
      (e) => e.type === "workspace.cleaned",
    );
    expect(event?.data).toMatchObject({ forced: false, landedIn: "origin/main" });
  });

  it("discards an open task's work for the human only", async () => {
    const s = await setup();
    const { task } = await s.h.manager("mgr").dispatch({
      repo: "app",
      title: "Hang",
      instructions: "[fake:hang]",
      idempotencyKey: "land-discard",
    });
    await waitForState(s.h, task.id, "running");
    await expect(s.h.manager("mgr").discardTask(task.id)).rejects.toMatchObject({
      code: "human_only",
    });
    const running = (await s.h.human.inspectTask(task.id)).task;
    writeFileSync(join(running.workspacePath!, "work.txt"), "unsaved\n");

    const gone = await s.h.human.discardTask(task.id, "wrong idea");
    expect(gone).toMatchObject({ state: "cancelled", workspacePath: null });
    expect(existsSync(running.workspacePath!)).toBe(false);
  });
});
