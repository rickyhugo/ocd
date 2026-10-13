import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { RecordingPullRequests } from "./pull-requests.ts";
import { declareRepos, makeRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A repo whose `origin` is a local bare repository, so pushes are real. */
async function repoWithOrigin(harness: Harness): Promise<{ path: string; origin: string }> {
  const path = makeRepo(harness.root, "app");
  const origin = join(harness.root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(path, "remote", "add", "origin", origin);
  git(path, "push", "-q", "-u", "origin", "main");
  git(path, "remote", "set-head", "origin", "main");
  await declareRepos(harness, { app: { path, profile: "fake" } });
  return { path, origin };
}

async function finishedTask(harness: Harness, key: string) {
  const { task } = await harness.human.dispatch({
    repo: "app",
    title: "Write the file",
    instructions: "x",
    idempotencyKey: key,
  });
  return waitForState(harness, task.id, "ready_for_review");
}

describe("pull requests (optional)", () => {
  it("commits on request, pushes the branch, opens one PR, and never merges", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    const { origin } = await repoWithOrigin(h);
    const done = await finishedTask(h, "pr-commit");

    await expect(h.human.openPullRequest(done.task.id)).rejects.toMatchObject({
      code: "workspace_dirty",
    });
    const opened = await h
      .manager("mgr")
      .openPullRequest(done.task.id, { commit: true, draft: true });
    expect(opened.pullRequestUrl).toBe("https://example.test/pr/1");
    expect(git(origin, "show-ref", "--verify", `refs/heads/${done.task.branch}`)).toContain(
      done.task.branch!,
    );
    expect(prs.created[0]).toMatchObject({
      head: done.task.branch,
      base: "main",
      title: "Write the file",
      draft: true,
    });
    expect(prs.created[0]?.body).toContain("Wrote ocd-fake.txt");
    expect(prs.created[0]?.body).toContain("`ocd-fake.txt`");

    const again = await h.human.openPullRequest(done.task.id);
    expect(again.pullRequestUrl).toBe(opened.pullRequestUrl);
    expect(prs.created).toHaveLength(1);
    expect(git(origin, "rev-parse", "main")).not.toBe(git(origin, "rev-parse", done.task.branch!));
  });

  it("is refused before the work is done or when PRs are not configured", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await repoWithOrigin(h);
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "pr-early",
    });
    await waitForState(h, task.id, "running");
    await expect(h.human.openPullRequest(task.id)).rejects.toMatchObject({
      code: "not_reviewable",
    });
  });
});

describe("workspace cleanup", () => {
  it("refuses to lose work unless a human forces it", async () => {
    h = await startHarness();
    await repoWithOrigin(h);
    const done = await finishedTask(h, "cleanup-guard");
    await expect(h.human.cleanupTask(done.task.id)).rejects.toMatchObject({ code: "not_finished" });
    await h.human.acceptTask(done.task.id);

    await expect(h.human.cleanupTask(done.task.id)).rejects.toMatchObject({
      code: "workspace_dirty",
    });
    git(done.task.workspacePath!, "add", "-A");
    git(
      done.task.workspacePath!,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "work",
    );
    await expect(h.human.cleanupTask(done.task.id)).rejects.toMatchObject({
      code: "unmerged_commits",
    });
    await expect(h.manager("mgr").cleanupTask(done.task.id, true)).rejects.toMatchObject({
      code: "human_only",
    });

    const cleaned = await h.human.cleanupTask(done.task.id, true);
    expect(cleaned.workspacePath).toBeNull();
    expect(existsSync(done.task.workspacePath!)).toBe(false);
    expect(() =>
      git(
        h!.root,
        "-C",
        join(h!.root, "app"),
        "show-ref",
        "--verify",
        `refs/heads/${done.task.branch}`,
      ),
    ).toThrow();
    const detail = await h.human.inspectTask(done.task.id);
    expect(detail.events.find((e) => e.type === "workspace.cleaned")?.data).toMatchObject({
      forced: true,
    });
  });

  it("cleans up without force once the work is on a remote (e.g. after a PR)", async () => {
    h = await startHarness({ pullRequests: new RecordingPullRequests() });
    await repoWithOrigin(h);
    const done = await finishedTask(h, "cleanup-after-pr");
    await h.human.openPullRequest(done.task.id, { commit: true });
    await h.manager("mgr").acceptTask(done.task.id);
    const cleaned = await h.manager("mgr").cleanupTask(done.task.id);
    expect(cleaned.workspacePath).toBeNull();
    expect(cleaned.pullRequestUrl).toBe("https://example.test/pr/1");
  });

  it("cleans up a cancelled task that changed nothing", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await repoWithOrigin(h);
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "cleanup-cancel",
    });
    const running = await waitForState(h, task.id, "running");
    await h.human.cancelTask(task.id);
    await h.human.cleanupTask(task.id);
    expect(existsSync(running.task.workspacePath!)).toBe(false);
    writeFileSync(join(h.root, "unused"), "");
  });
});

describe("merging pull requests", () => {
  async function openedAndAccepted(harness: Harness, key: string) {
    const done = await finishedTask(harness, key);
    const opened = await harness.human.openPullRequest(done.task.id, { commit: true });
    await harness.human.acceptTask(done.task.id);
    return { ...done.task, pullRequestUrl: opened.pullRequestUrl! };
  }

  it("refuses until GitHub says the PR is safe to merge, and never overrides", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    await repoWithOrigin(h);
    const unopened = await finishedTask(h, "merge-none");
    await expect(h.human.mergePullRequest(unopened.task.id)).rejects.toMatchObject({
      code: "no_pull_request",
    });
    await h.human.openPullRequest(unopened.task.id, { commit: true });
    await expect(h.human.mergePullRequest(unopened.task.id)).rejects.toMatchObject({
      code: "not_accepted",
    });

    const task = await openedAndAccepted(h, "merge-refuse");
    const cases: [Partial<import("./pull-requests.ts").PullRequestStatus>, string][] = [
      [{ failingChecks: ["ci/test"] }, "pr_checks_failed"],
      [{ pendingChecks: ["ci/build"] }, "pr_checks_pending"],
      [{ mergeable: "conflicting" }, "pr_conflicts"],
      [{ draft: true }, "pr_draft"],
      [{ mergeState: "BLOCKED" }, "pr_blocked"],
      [{ mergeable: "unknown" }, "pr_not_ready"],
      [{ state: "closed" }, "pr_closed"],
    ];
    for (const [status, code] of cases) {
      prs.statuses.set(task.pullRequestUrl, status);
      await expect(h.manager("mgr").mergePullRequest(task.id)).rejects.toMatchObject({ code });
    }
    expect(prs.merged).toEqual([]);
  });

  it("merges with the repo's method, then removes the worktree and both branches", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    const { path, origin } = await repoWithOrigin(h);
    await declareRepos(h, { app: { path, profile: "fake", mergeMethod: "rebase" } });
    const task = await openedAndAccepted(h, "merge-ok");
    expect(git(origin, "show-ref", "--verify", `refs/heads/${task.branch}`)).toBeTruthy();

    const merged = await h.manager("mgr").mergePullRequest(task.id);
    expect(prs.merged).toEqual([{ url: task.pullRequestUrl, method: "rebase" }]);
    expect(merged.workspacePath).toBeNull();
    expect(existsSync(task.workspacePath!)).toBe(false);
    expect(() => git(path, "show-ref", "--verify", `refs/heads/${task.branch}`)).toThrow();
    expect(() => git(origin, "show-ref", "--verify", `refs/heads/${task.branch}`)).toThrow();
    const event = (await h.human.inspectTask(task.id)).events.find(
      (e) => e.type === "pull_request.merged",
    );
    expect(event?.data).toMatchObject({
      method: "rebase",
      actor: "manager",
      remoteBranchDeleted: true,
    });

    // Asking again is harmless.
    await h.human.mergePullRequest(task.id, "squash");
    expect(prs.merged).toHaveLength(1);
  });

  it("finishes cleanup when the PR was already merged on GitHub", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    await repoWithOrigin(h);
    const task = await openedAndAccepted(h, "merge-external");
    prs.statuses.set(task.pullRequestUrl, { state: "merged" });
    const done = await h.human.mergePullRequest(task.id, "merge");
    expect(prs.merged).toEqual([]);
    expect(done.workspacePath).toBeNull();
  });
});

describe("check classification", () => {
  it("separates failing and pending checks from GitHub's rollup", async () => {
    const { classifyChecks } = await import("./pull-requests.ts");
    expect(
      classifyChecks([
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "build", status: "IN_PROGRESS", conclusion: null },
        { name: "skipped", status: "COMPLETED", conclusion: "SKIPPED" },
        { context: "ci/legacy", state: "PENDING" },
        { context: "ci/old", state: "ERROR" },
      ]),
    ).toEqual({ failing: ["lint", "ci/old"], pending: ["build", "ci/legacy"] });
  });
});
