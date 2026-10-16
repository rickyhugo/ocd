import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import {
  capabilitiesOf,
  redact,
  truncate,
  type Actor,
  type LandPlan,
  type LandResult,
  type MergeMethod,
  type Task,
} from "@ocd/core";

import type { LiveConfig } from "./config.ts";
import { ApiError, conflict, forbidden } from "./errors.ts";
import { iso, type Clock } from "./ids.ts";
import type { Logger } from "./logger.ts";
import { managerWake } from "./notification.ts";
import type { PullRequestHost } from "./pull-requests.ts";
import type { Store } from "./store.ts";
import type { WorkspaceManager } from "./workspace.ts";

// Landing: getting a finished task's work into its base branch, and removing
// what is left afterwards. Through a pull request (open, merge once GitHub
// allows, clean up) or directly (one push the human confirmed). It takes the
// narrow slice of the store, workspace and host it needs, so it can be driven
// with fakes; the Supervisor supplies task locking, accepting and cancelling.

/** Refuses before any side effect, so a task without a workspace stays reviewable. */
function assertLandable(task: Task): void {
  if (!capabilitiesOf(task).land)
    throw conflict(
      "no_workspace",
      `Task ${task.id} has no workspace, so there is nothing to land; accept it instead`,
    );
}

/** Pull request merge refusals that `land` reports as what is left, not as failures. */
const PR_WAITING = new Set([
  "pr_checks_pending",
  "pr_not_ready",
  "pr_checks_failed",
  "pr_blocked",
  "pr_draft",
  "pr_conflicts",
]);

export interface LandingOptions {
  store: Pick<
    Store,
    | "requireTask"
    | "requireRepo"
    | "listTasks"
    | "listAttention"
    | "raiseAttention"
    | "settleAttention"
    | "patchTask"
    | "appendEvent"
    | "enqueue"
  >;
  workspaces: Pick<
    WorkspaceManager,
    | "branchFor"
    | "branchSafety"
    | "remove"
    | "commitAll"
    | "verify"
    | "defaultBranch"
    | "fetchBranch"
    | "push"
    | "pushCommit"
    | "deleteRemoteBranch"
    | "head"
    | "commitsBetween"
    | "filesChangedSince"
    | "landingCommit"
    | "landedIn"
  >;
  /** Absent means pull requests are off. */
  pullRequests?: PullRequestHost | undefined;
  live: Pick<LiveConfig, "mergeMethod">;
  logger: Logger;
  clock: Clock;
  autoCleanup: () => { enabled: boolean; afterHours: number };
  /** Where a task without a worktree works; cleanup removes it. */
  scratchDirectory: (taskId: string) => string;
  attentionExpiryMinutes: () => number;
  stopped: () => boolean;
  /** A task's work reached its repository's base branch (direct push or merged PR). */
  onLanded?: ((repo: string) => void) | undefined;
  /** Runs fn serialized with everything else on the task. */
  withTaskLock: <T>(taskId: string, fn: () => Promise<T>) => Promise<T>;
  /** Task transitions the Supervisor owns (they also release workers and reschedule). */
  accept: (taskId: string, actor: Actor) => Promise<Task>;
  /** accept() inside the task lock. */
  acceptLocked: (taskId: string, actor: Actor) => Task;
  cancel: (taskId: string, reason: string | undefined) => Promise<Task>;
  /** Finished tasks need no live worker; process-owned harnesses stop theirs. */
  releaseWorker: (task: Task) => void;
  /** Asks the scheduler to look for work now. */
  tick: () => void;
}

export class LandingService {
  /** Worktrees automatic cleanup kept because work would be lost; not retried until restart. */
  private readonly keptByAutoCleanup = new Set<string>();

  private readonly o: LandingOptions;

  constructor(o: LandingOptions) {
    this.o = o;
  }

  /**
   * autoCleanup: removes the worktrees (or scratch directories) of tasks
   * finished more than afterHours ago the way `ocd task cleanup` does, never
   * forced; one whose work would be lost is kept (and not retried until the
   * next start).
   */
  async autoCleanup(): Promise<string[]> {
    const settings = this.o.autoCleanup();
    if (!settings.enabled || this.o.stopped()) return [];
    const cutoff = this.o.clock() - settings.afterHours * 3_600_000;
    const due = this.o.store
      .listTasks({ state: ["completed", "cancelled"], limit: 500 })
      .filter(
        (t) =>
          (capabilitiesOf(t).worktree
            ? t.workspacePath
            : existsSync(this.o.scratchDirectory(t.id))) &&
          !this.keptByAutoCleanup.has(t.id) &&
          Date.parse(t.finishedAt ?? t.updatedAt) <= cutoff,
      );
    const cleaned: string[] = [];
    for (const task of due) {
      if (this.o.stopped()) break;
      try {
        await this.cleanup(task.id, false, "manager", { auto: true });
        cleaned.push(task.id);
      } catch (error) {
        this.keptByAutoCleanup.add(task.id);
        this.o.logger.info(
          { taskId: task.id, reason: error instanceof Error ? error.message : String(error) },
          "automatic cleanup kept a worktree",
        );
      }
    }
    if (cleaned.length)
      this.o.logger.info({ tasks: cleaned }, "automatic cleanup removed worktrees");
    return cleaned;
  }

  /**
   * Removes a finished task's worktree and branch. Refuses when that would
   * lose work (uncommitted files, or commits that exist on no other branch or
   * remote) unless forced; only a human may force. A task without a worktree
   * has only its scratch directory, which is removed.
   */
  async cleanup(
    taskId: string,
    force: boolean,
    actor: Actor,
    options: { auto?: boolean } = {},
  ): Promise<Task> {
    if (force && actor !== "human")
      throw forbidden("human_only", "Only a human can force a cleanup that discards work");
    return this.o.withTaskLock(taskId, async () => {
      const task = this.o.store.requireTask(taskId);
      if (task.state !== "completed" && task.state !== "cancelled") {
        throw conflict(
          "not_finished",
          `Only completed or cancelled tasks can be cleaned up (task is ${task.state})`,
        );
      }
      if (!capabilitiesOf(task).worktree) {
        const scratch = this.o.scratchDirectory(taskId);
        if (!existsSync(scratch)) return task;
        try {
          await rm(scratch, { recursive: true, force: true });
        } catch (error) {
          throw conflict(
            "cleanup_failed",
            `Could not remove ${scratch}: ${truncate(redact(error instanceof Error ? error.message : String(error)), 500)}`,
          );
        }
        this.o.store.appendEvent(taskId, "workspace.cleaned", {
          scratch,
          forced: force,
          actor,
          ...(options.auto ? { auto: true } : {}),
        });
        return task;
      }
      const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
      const branch = task.branch ?? this.o.workspaces.branchFor(taskId);
      const safety = await this.o.workspaces.branchSafety(repo.path, task.workspacePath, branch);
      if (!safety.worktreeExists && !safety.branchExists) return task;
      if (!force && safety.dirtyFiles.length > 0) {
        throw conflict(
          "workspace_dirty",
          `${safety.dirtyFiles.length} uncommitted file(s) in ${task.workspacePath}; commit or open a PR first, or force`,
          {
            files: safety.dirtyFiles.slice(0, 20),
          },
        );
      }
      // A squash or rebase merge leaves the branch's own commits unmerged even
      // though its changes are in the base branch; that counts as landed.
      let landedIn: string | null = null;
      if (!force && safety.unmergedCommits > 0) {
        landedIn = await this.landedBase(repo.path, branch, task.baseRef);
        if (!landedIn)
          throw conflict(
            "unmerged_commits",
            `${safety.unmergedCommits} commit(s) on ${branch} exist on no other branch or remote and are not in the base branch; land them (ocd task land), or force`,
          );
      }
      try {
        await this.o.workspaces.remove(
          repo.path,
          task.workspacePath,
          branch,
          force || landedIn !== null,
        );
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw conflict(
          "cleanup_failed",
          `Could not remove ${task.workspacePath ?? branch}: ${truncate(redact(error instanceof Error ? error.message : String(error)), 500)}`,
        );
      }
      this.settleLandAttention(taskId);
      this.o.store.patchTask(
        taskId,
        { workspacePath: null },
        {
          type: "workspace.cleaned",
          data: {
            path: task.workspacePath,
            branch,
            forced: force,
            actor,
            discarded: force ? safety : null,
            landedIn,
            ...(options.auto ? { auto: true } : {}),
          },
        },
      );
      return this.o.store.requireTask(taskId);
    });
  }

  /**
   * Optional: pushes the task branch and opens a pull request. Never merges.
   * With commit, uncommitted worker changes are committed first.
   */
  async openPullRequest(
    taskId: string,
    options: { draft: boolean; base?: string | undefined; commit: boolean },
    actor: Actor,
  ): Promise<Task> {
    return this.o.withTaskLock(taskId, async () => {
      const task = this.o.store.requireTask(taskId);
      assertLandable(task);
      if (task.pullRequestUrl) return task;
      if (task.state !== "ready_for_review" && task.state !== "completed") {
        throw conflict(
          "not_reviewable",
          `Open a pull request after the work is done (task is ${task.state})`,
        );
      }
      if (!this.o.pullRequests)
        throw new ApiError(
          422,
          "pr_unavailable",
          'Pull requests are off; set "github": { "enabled": true } in ocd.jsonc and restart the supervisor',
        );
      if (!task.workspacePath || !task.branch || !task.baseRef)
        throw conflict("no_workspace", "The task has no workspace to push");
      const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
      if (options.commit)
        await this.o.workspaces.commitAll(
          task.workspacePath,
          `${task.title}\n\nOCD task ${task.id}`,
        );
      const facts = await this.o.workspaces.verify({
        path: task.workspacePath,
        baseRef: task.baseRef,
      });
      if (facts.dirty)
        throw conflict(
          "workspace_dirty",
          "The worktree has uncommitted changes; commit them first (--commit)",
        );
      if (facts.commitsAhead === 0)
        throw conflict("nothing_to_push", `${task.branch} has no commits beyond its base`);
      const remote = "origin";
      const base = options.base ?? (await this.o.workspaces.defaultBranch(repo.path, remote));
      await this.o.workspaces.push(task.workspacePath, remote, task.branch);
      const host = this.o.pullRequests;
      const { url, existing } = await this.recordPullRequestFailure(
        taskId,
        { stage: "create", branch: task.branch, base, pushed: true, actor },
        () =>
          host.create({
            cwd: task.workspacePath!,
            head: task.branch!,
            base,
            title: task.title,
            body: this.pullRequestBody(task, facts.changedFiles),
            draft: options.draft,
          }),
      );
      this.o.store.patchTask(
        taskId,
        { pullRequestUrl: url },
        {
          type: "pull_request.opened",
          data: { url, base, draft: options.draft, actor, existing: existing ?? false },
        },
      );
      return this.o.store.requireTask(taskId);
    });
  }

  /**
   * Merges an accepted task's pull request after checking GitHub's view of it,
   * then removes the worktree and both branches. Never overrides branch
   * protection, failing or pending checks, conflicts, or drafts.
   */
  async mergePullRequest(
    taskId: string,
    options: { method?: MergeMethod | undefined },
    actor: Actor,
  ): Promise<Task> {
    return (
      await this.o.withTaskLock(taskId, () => this.mergePullRequestLocked(taskId, options, actor))
    ).task;
  }

  private async mergePullRequestLocked(
    taskId: string,
    options: { method?: MergeMethod | undefined },
    actor: Actor,
  ): Promise<{ task: Task; merged: boolean; keptReason: string | null }> {
    {
      const task = this.o.store.requireTask(taskId);
      assertLandable(task);
      const url = task.pullRequestUrl;
      if (!url) throw conflict("no_pull_request", "The task has no pull request; open one first");
      if (task.state !== "completed")
        throw conflict("not_accepted", `Accept the task before merging (task is ${task.state})`);
      const host = this.o.pullRequests;
      if (!host)
        throw new ApiError(
          422,
          "pr_unavailable",
          'Pull requests are off; set "github": { "enabled": true } in ocd.jsonc and restart the supervisor',
        );
      const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
      const method = options.method ?? this.o.live.mergeMethod(task.repo);
      const gh = <T>(stage: string, fn: () => Promise<T>) =>
        this.recordPullRequestFailure(taskId, { stage, url, actor }, fn);
      let status = await gh("status", () => host.status(url, repo.path));
      if (status.state === "closed")
        throw conflict("pr_closed", `${url} is closed without merging`);
      if (status.state === "open") {
        if (status.draft)
          throw conflict("pr_draft", `${url} is a draft; mark it ready for review first`);
        if (status.mergeable === "conflicting")
          throw conflict("pr_conflicts", `${url} has merge conflicts with its base`);
        if (status.failingChecks.length) {
          throw conflict(
            "pr_checks_failed",
            `Checks failing on ${url}: ${status.failingChecks.join(", ")}`,
            { checks: status.failingChecks },
          );
        }
        if (status.pendingChecks.length) {
          throw conflict(
            "pr_checks_pending",
            `Checks still running on ${url}: ${status.pendingChecks.join(", ")}`,
            { checks: status.pendingChecks },
          );
        }
        if (status.mergeable === "unknown")
          throw conflict(
            "pr_not_ready",
            "GitHub is still computing mergeability; try again shortly",
          );
        if (status.mergeState === "BLOCKED") {
          throw conflict(
            "pr_blocked",
            `${url} is blocked by branch protection or required reviews; OCD never overrides that`,
          );
        }
        // Bound to the head that was checked: a push since then is not merged.
        const checkedHead = status.headSha;
        await gh("merge", () => host.merge(url, repo.path, method, checkedHead));
        status = await gh("status", () => host.status(url, repo.path));
        if (status.state !== "merged") {
          // e.g. a merge queue: GitHub accepted the request but has not merged yet.
          this.o.store.appendEvent(taskId, "pull_request.merge_requested", { url, method, actor });
          return { task: this.o.store.requireTask(taskId), merged: false, keptReason: null };
        }
      }
      this.o.onLanded?.(task.repo);
      // Merged on GitHub. Local copies go only if nothing exists beyond what GitHub merged:
      // commits added after the push and uncommitted edits stay.
      const branch = task.branch ?? this.o.workspaces.branchFor(taskId);
      const keptReason = await this.localWorkBeyondMerge(task, repo.path, branch, status.headSha);
      if (keptReason) {
        this.o.store.appendEvent(taskId, "pull_request.merged", {
          url,
          method,
          actor,
          worktreeKept: true,
          reason: keptReason,
          remoteBranchDeleted: false,
        });
        return { task: this.o.store.requireTask(taskId), merged: true, keptReason };
      }
      try {
        await this.o.workspaces.remove(repo.path, task.workspacePath, branch, true);
      } catch (error) {
        // The merge itself succeeded; keep the copies and say why.
        const reason = `Could not remove the worktree: ${truncate(redact(error instanceof Error ? error.message : String(error)), 300)}`;
        this.o.store.appendEvent(taskId, "pull_request.merged", {
          url,
          method,
          actor,
          worktreeKept: true,
          reason,
          remoteBranchDeleted: false,
        });
        return { task: this.o.store.requireTask(taskId), merged: true, keptReason: reason };
      }
      const remoteDeleted = await this.o.workspaces.deleteRemoteBranch(repo.path, "origin", branch);
      this.settleLandAttention(taskId);
      this.o.store.patchTask(
        taskId,
        { workspacePath: null },
        {
          type: "pull_request.merged",
          data: { url, method, actor, remoteBranchDeleted: remoteDeleted },
        },
      );
      return { task: this.o.store.requireTask(taskId), merged: true, keptReason: null };
    }
  }

  /**
   * Why the local copies of a merged PR must not be removed: the worktree has
   * uncommitted edits, or the branch has commits beyond the PR head that the
   * merge did not take and the base does not contain. Null when everything is
   * on GitHub.
   */
  private async localWorkBeyondMerge(
    task: Task,
    repoPath: string,
    branch: string,
    prHead: string | undefined,
  ): Promise<string | null> {
    const safety = await this.o.workspaces.branchSafety(repoPath, task.workspacePath, branch);
    if (safety.dirtyFiles.length > 0)
      return `${safety.dirtyFiles.length} uncommitted file(s) in the worktree`;
    if (!safety.branchExists) return null;
    // Head known: identical means nothing extra. Otherwise count commits that exist nowhere else.
    if (prHead && task.workspacePath) {
      const local = await this.o.workspaces.head(task.workspacePath).catch(() => null);
      if (local === prHead) return null;
    } else if (safety.unmergedCommits === 0) {
      return null;
    }
    const landedIn = await this.landedBase(repoPath, branch, task.baseRef).catch(() => null);
    return landedIn
      ? null
      : `${branch} has commits beyond the merged pull request that are not in the base branch`;
  }

  /** What a direct landing would push. Fetches the base branch; changes nothing. */
  async landPlan(taskId: string): Promise<LandPlan> {
    return this.planLanding(this.o.store.requireTask(taskId));
  }

  private async planLanding(task: Task): Promise<LandPlan> {
    assertLandable(task);
    if (task.state !== "ready_for_review" && task.state !== "completed")
      throw conflict("not_reviewable", `Land a task once its work is done (task is ${task.state})`);
    if (!task.workspacePath || !task.branch)
      throw conflict("no_workspace", "The task has no worktree to land");
    const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
    const remote = "origin";
    const base = await this.o.workspaces.defaultBranch(repo.path, remote);
    if (!(await this.o.workspaces.fetchBranch(task.workspacePath, remote, base)))
      throw conflict(
        "fetch_failed",
        `Could not fetch ${remote}/${base}; check the network and your git credentials`,
      );
    const onto = `${remote}/${base}`;
    const [head, commits, files, facts] = await Promise.all([
      this.o.workspaces.head(task.workspacePath),
      this.o.workspaces.commitsBetween(task.workspacePath, onto, "HEAD"),
      this.o.workspaces.filesChangedSince(task.workspacePath, onto),
      this.o.workspaces.verify({ path: task.workspacePath, baseRef: onto }),
    ]);
    const plan: LandPlan = {
      taskId: task.id,
      title: task.title,
      repo: task.repo,
      remote,
      base,
      method: this.o.live.mergeMethod(task.repo),
      head,
      commits: commits.map(({ sha, subject }) => ({ sha, subject })),
      files,
      dirty: facts.dirty,
      pullRequestUrl: task.pullRequestUrl,
      blocker: null,
    };
    try {
      this.assertDirectLandable(plan);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      plan.blocker = { code: error.code, message: error.message };
    }
    return plan;
  }

  /**
   * Gets a finished task's work into its base branch, as far as is safe right
   * now, and says what is left. Through a pull request (default): accept, open
   * or reuse the PR, merge it once GitHub allows, clean up; run it again to
   * continue. Directly: push one landing commit to the base branch, only after
   * the human confirmed exactly that push.
   */
  async land(
    taskId: string,
    input: { direct: boolean; commit: boolean; confirm?: string | undefined },
    actor: Actor,
  ): Promise<LandResult> {
    assertLandable(this.o.store.requireTask(taskId));
    return input.direct
      ? this.landDirect(taskId, input.confirm, actor)
      : this.landThroughPullRequest(taskId, input.commit, actor);
  }

  private async landThroughPullRequest(
    taskId: string,
    commit: boolean,
    actor: Actor,
  ): Promise<LandResult> {
    const steps: string[] = [];
    const result = (task: Task, waiting: LandResult["waiting"]): LandResult => ({
      task,
      landed: waiting === null,
      steps,
      waiting,
      attentionId: null,
      commit: null,
    });
    let task = this.o.store.requireTask(taskId);
    const host = this.o.pullRequests;
    if (!host)
      throw new ApiError(
        422,
        "pr_unavailable",
        'Landing through a pull request needs "github": { "enabled": true } in ocd.jsonc (then restart the supervisor); or push directly with ocd task land --direct',
      );
    // The worktree is gone: either merged and cleaned up, or cleaned up while the PR is still open.
    if (task.state === "completed" && task.pullRequestUrl && !task.workspacePath) {
      const url = task.pullRequestUrl;
      const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
      const status = await this.recordPullRequestFailure(
        taskId,
        { stage: "status", url, actor },
        () => host.status(url, repo.path),
      );
      if (status.state === "merged") return result(task, null);
      return result(task, {
        code: status.state === "closed" ? "pr_closed" : "pr_not_merged",
        message:
          status.state === "closed"
            ? `${url} was closed without merging and the task's worktree is gone`
            : `${url} is not merged and the task's worktree is gone; merge it on GitHub (or ocd task merge)`,
      });
    }
    if (task.state === "ready_for_review") {
      // Refuse before accepting: a task that cannot get a PR stays steerable.
      if (!task.pullRequestUrl) await this.assertPullRequestOpenable(task, commit);
      task = await this.o.accept(taskId, actor);
      steps.push("accepted");
    }
    if (!task.pullRequestUrl) {
      task = await this.openPullRequest(taskId, { draft: false, commit }, actor);
      steps.push(`opened ${task.pullRequestUrl}`);
    }
    let merged: { task: Task; merged: boolean; keptReason: string | null };
    try {
      merged = await this.o.withTaskLock(taskId, () =>
        this.mergePullRequestLocked(taskId, {}, actor),
      );
      task = merged.task;
    } catch (error) {
      if (error instanceof ApiError && PR_WAITING.has(error.code))
        return result(task, { code: error.code, message: error.message });
      throw error;
    }
    if (!merged.merged)
      return result(task, {
        code: "merge_queued",
        message: `GitHub accepted the merge of ${task.pullRequestUrl} but has not merged it yet`,
      });
    steps.push(`merged ${task.pullRequestUrl}`);
    if (merged.keptReason)
      return result(task, {
        code: "worktree_kept",
        message: `Merged, but the worktree and branch were kept: ${merged.keptReason}`,
      });
    steps.push("removed the worktree and branches");
    return result(task, null);
  }

  /** The checks openPullRequest would fail on, run before the task is accepted. */
  private async assertPullRequestOpenable(task: Task, commit: boolean): Promise<void> {
    if (!task.workspacePath || !task.branch || !task.baseRef)
      throw conflict("no_workspace", "The task has no workspace to push");
    const facts = await this.o.workspaces.verify({
      path: task.workspacePath,
      baseRef: task.baseRef,
    });
    if (facts.dirty && !commit)
      throw conflict(
        "workspace_dirty",
        "The worktree has uncommitted changes; commit them first (--commit)",
      );
    if (facts.commitsAhead === 0 && !(facts.dirty && commit))
      throw conflict("nothing_to_push", `${task.branch} has no commits beyond its base`);
  }

  private async landDirect(
    taskId: string,
    confirm: string | undefined,
    actor: Actor,
  ): Promise<LandResult> {
    const plan = await this.planLanding(this.o.store.requireTask(taskId));
    this.assertDirectLandable(plan);
    if (actor !== "human") {
      // The manager may only ask: the human confirms this exact push.
      const commits = `${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}`;
      const { attention, created } = this.o.store.raiseAttention(
        {
          taskId,
          kind: "land",
          dedupeKey: `land:${taskId}:${plan.head}`,
          reason: `Push ${commits} of "${truncate(plan.title, 80)}" to ${plan.remote}/${plan.base} (${plan.method})`,
          operation: plan,
          resolvableBy: "human",
          expiresAt: iso(this.o.clock() + this.o.attentionExpiryMinutes() * 60_000),
        },
        {
          notify: true,
          wake: false,
          notice: {
            headline: `Confirm push to ${plan.base}`,
            detail: `${commits}, ${plan.method}`,
          },
        },
      );
      if (created)
        this.o.store.appendEvent(taskId, "land.requested", {
          actor,
          base: plan.base,
          head: plan.head,
          attention: attention.id,
        });
      return {
        task: this.o.store.requireTask(taskId),
        landed: false,
        steps: [created ? "asked the human to confirm the push" : "already waiting for the human"],
        waiting: {
          code: "confirmation_requested",
          message: `The human must confirm the push: ocd attention resolve ${attention.id} --approve (or the task's row in the sidebar)`,
        },
        attentionId: attention.id,
        commit: null,
      };
    }
    if (!confirm || confirm.length < 7 || !plan.head.startsWith(confirm))
      throw conflict(
        "confirmation_required",
        `Confirm the push to ${plan.remote}/${plan.base} first (ocd task land ${taskId} --direct asks)`,
        { plan },
      );
    return this.o.withTaskLock(taskId, () => this.pushLanding(taskId, plan.head, actor, null));
  }

  private assertDirectLandable(plan: Omit<LandPlan, "blocker">): void {
    if (plan.pullRequestUrl)
      throw conflict(
        "has_pull_request",
        `The task already has a pull request (${plan.pullRequestUrl}); land it through the pull request`,
      );
    if (plan.dirty)
      throw conflict(
        "workspace_dirty",
        "The worktree has uncommitted changes; have the worker commit them, or commit them yourself, then land",
      );
    if (!plan.commits.length)
      throw conflict(
        "nothing_to_push",
        `The task branch has no commits that ${plan.remote}/${plan.base} does not already have`,
      );
  }

  /**
   * Inside the task lock: plans again, refuses if the branch moved since the
   * human confirmed `confirmedHead`, then pushes the landing commit (a plain
   * fast-forward push: never forced, hooks and branch protection apply),
   * accepts the task and removes its worktree and branch.
   */
  async pushLanding(
    taskId: string,
    confirmedHead: string,
    actor: Actor,
    attentionId: string | null,
  ): Promise<LandResult> {
    const short = (sha: string) => sha.slice(0, 7);
    const plan = await this.planLanding(this.o.store.requireTask(taskId));
    this.assertDirectLandable(plan);
    if (plan.head !== confirmedHead)
      throw conflict(
        "plan_changed",
        `The task branch moved since the push was confirmed (${short(confirmedHead)} is now ${short(plan.head)}); confirm again`,
      );
    const task = this.o.store.requireTask(taskId);
    const workspacePath = task.workspacePath!;
    const target = `${plan.remote}/${plan.base}`;
    let commit: string;
    try {
      commit = await this.o.workspaces.landingCommit(workspacePath, {
        onto: target,
        head: plan.head,
        method: plan.method,
        message:
          plan.method === "merge"
            ? `Merge OCD task ${task.id}: ${task.title}`
            : `${task.title}\n\nOCD task ${task.id}`,
      });
      await this.o.workspaces.pushCommit(workspacePath, plan.remote, commit, plan.base);
    } catch (error) {
      const e = error as Error & { code?: unknown };
      this.o.store.appendEvent(taskId, "land.failed", {
        via: "direct",
        base: plan.base,
        head: plan.head,
        actor,
        code: typeof e.code === "string" ? e.code : "internal",
        message: truncate(redact(e.message ?? String(error)), 2000),
      });
      throw error;
    }
    const steps: string[] = [];
    if (task.state === "ready_for_review") {
      this.o.acceptLocked(taskId, actor);
      steps.push("accepted");
    }
    steps.push(`pushed ${short(commit)} to ${target} (${plan.method})`);
    // The work is on the remote base branch now, so the local copies can go.
    const repo = this.o.store.requireRepo(task.repo, { includeRetired: true });
    let removed = true;
    try {
      await this.o.workspaces.remove(repo.path, workspacePath, task.branch!, true);
      steps.push("removed the worktree and branch");
    } catch (error) {
      removed = false;
      steps.push(`kept the worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.settleLandAttention(taskId, attentionId);
    this.o.store.patchTask(taskId, removed ? { workspacePath: null } : {}, {
      type: "task.landed",
      data: {
        via: "direct",
        remote: plan.remote,
        base: plan.base,
        method: plan.method,
        commit,
        head: plan.head,
        commits: plan.commits.length,
        actor,
        attention: attentionId,
      },
    });
    const landed = this.o.store.requireTask(taskId);
    this.o.onLanded?.(landed.repo);
    this.o.store.enqueue([
      managerWake(
        landed,
        `landed:${commit}`,
        `[landed] Task ${landed.id} ("${landed.title}", repo ${landed.repo}) was pushed to ${target} as ${short(commit)} (${plan.method}), confirmed by the human.${removed ? " Its worktree and branch are removed." : ""}`,
      ),
    ]);
    this.o.releaseWorker(landed);
    this.o.tick();
    return { task: landed, landed: true, steps, waiting: null, attentionId, commit };
  }

  /**
   * Cancels the task if it is still open, then removes its worktree and
   * branch (or scratch directory) even if that loses uncommitted changes or
   * unpushed commits.
   */
  async discard(taskId: string, reason: string | undefined, actor: Actor): Promise<Task> {
    if (actor !== "human") throw forbidden("human_only", "Only a human can discard a task's work");
    const task = this.o.store.requireTask(taskId);
    if (task.state !== "completed" && task.state !== "cancelled")
      await this.o.cancel(taskId, reason ?? "discarded");
    return this.cleanup(taskId, true, actor);
  }

  /**
   * Runs one GitHub step; a failure is recorded on the task (redacted) so an
   * interrupted PR operation is visible later, then rethrown unchanged.
   */
  private async recordPullRequestFailure<T>(
    taskId: string,
    context: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const e = error as Error & { code?: unknown };
      this.o.store.appendEvent(taskId, "pull_request.failed", {
        ...context,
        code: typeof e.code === "string" ? e.code : "internal",
        message: truncate(redact(e.message ?? String(error)), 2000),
      });
      throw error;
    }
  }

  private pullRequestBody(task: Task, changedFiles: string[]): string {
    const report = task.result?.reported;
    const clean = (text: string, max: number) => truncate(redact(text), max);
    // A command goes in a code span: no backticks or line breaks to end it early.
    const code = (text: string) => clean(text, 500).replaceAll("`", "'").replaceAll(/\s+/g, " ");
    return [
      report ? `## Summary\n\n${clean(report.summary, 4000)}` : "",
      task.acceptanceCriteria.length
        ? `## Acceptance criteria\n\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
        : "",
      report?.tests.length
        ? `## Worker-reported checks\n\n${report.tests.map((t) => `- ${t.outcome}: \`${code(t.command)}\``).join("\n")}`
        : "",
      report?.unresolved.length
        ? `## Unresolved\n\n${report.unresolved.map((u) => `- ${clean(u, 2000)}`).join("\n")}`
        : "",
      `## Changed files (verified by OCD)\n\n${changedFiles.map((f) => `- \`${f}\``).join("\n") || "none"}`,
      `---\nOpened by OCD for task \`${task.id}\` (${task.harness}, ${task.model}). Review before merging.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** The base branch that already contains all of `branch`'s changes, if any (fetches first). */
  private async landedBase(
    repoPath: string,
    branch: string,
    baseRef: string | null,
  ): Promise<string | null> {
    const remote = "origin";
    const base = await this.o.workspaces.defaultBranch(repoPath, remote);
    await this.o.workspaces.fetchBranch(repoPath, remote, base);
    return this.o.workspaces.landedIn(repoPath, branch, [
      `${remote}/${base}`,
      ...(baseRef ? [baseRef] : []),
    ]);
  }

  /** A pending direct-push confirmation is moot once the task is landed, cleaned up or discarded. */
  private settleLandAttention(taskId: string, except?: string | null): void {
    for (const a of this.o.store.listAttention({ taskId, status: "open", kinds: ["land"] })) {
      if (a.id !== except) this.o.store.settleAttention(a.id, { status: "expired" });
    }
  }

  /** The human declined a direct push: tell the manager not to ask again. */
  declineLanding(task: Task, attentionId: string, message: string | undefined): void {
    this.o.store.enqueue([
      managerWake(
        task,
        `land-declined:${attentionId}`,
        `[land] The human declined pushing task ${task.id} ("${task.title}") directly${message ? `: ${message}` : ""}. Do not ask again unless they say so.`,
      ),
    ]);
  }
}
