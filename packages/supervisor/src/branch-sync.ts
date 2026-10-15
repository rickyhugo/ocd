import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  LIVE_STATES,
  OPEN_STATES,
  redact,
  truncate,
  type BranchSync,
  type Repository,
  type Task,
  type TaskState,
} from "@ocd/core";

import type { LiveConfig } from "./config.ts";
import { SimulatedCrash } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./store.ts";
import { type GitRunner, gitText, systemGit } from "./git.ts";
import type { WorkspaceManager } from "./workspace.ts";

// The branch-sync watchdog (docs/branch-sync.md). It compares each open task
// branch with its repository's configured baseRef and, only when enabled,
// brings clean idle branches up to date at safe lifecycle boundaries. It never
// pushes, fetches, rebases, stashes, resets, resolves conflicts, or touches a
// worktree that OCD did not create for the task.

/** What asked for the sync: the periodic tick or a lifecycle boundary. */
export type SyncTrigger = "periodic" | "launch" | "follow_up" | "hand_back";

export type SyncPoint = "before_branch_sync_recheck" | "after_branch_sync_write";

export interface SyncOutcome {
  status: BranchSync | null;
  refreshed: boolean;
  /** Told to the worker in its next prompt when the branch was refreshed. */
  note: string | null;
}

const NONE: SyncOutcome = { status: null, refreshed: false, note: null };

/** Git state files that mean an operation is half done in a worktree. */
const IN_PROGRESS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
  "sequencer",
  "index.lock",
];

const MAX_LISTED_FILES = 20;

/** Why a task in this state is not refreshed by this trigger, or null when it may be. */
export function deferral(state: TaskState, trigger: SyncTrigger): string | null {
  if (state === "queued" && (trigger === "periodic" || trigger === "launch")) return null;
  if (state === "ready_for_review" && trigger === "follow_up") return null;
  if (state === "manual" && trigger === "hand_back") return null;
  switch (state) {
    case "queued":
      return "waiting to launch; refreshed by the next check or at launch";
    case "starting":
    case "running":
    case "blocked":
      return "a worker is active; deferred until the task is idle";
    case "ready_for_review":
      return "ready for review, so it is not changed under the reviewer; a follow-up (ocd task send) refreshes it first and the worker re-reports";
    case "manual":
      return "in manual mode; deferred until handed back with --mode continue";
    case "needs_attention":
    case "interrupted":
    case "failed":
      return "the last run is uncertain; deferred until an explicit relaunch (ocd task resume --mode relaunch)";
    default:
      return "the task is finished";
  }
}

export function branchSyncAttentionKey(taskId: string): string {
  return `branch-sync:${taskId}`;
}

const short = (sha: string) => sha.slice(0, 10);

function listFiles(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return files.length > 5 ? `${shown} and ${files.length - 5} more` : shown;
}

/** Entries of `git status --porcelain=v1 -z`, keeping the status column. */
function statusEntries(output: string): { xy: string; path: string }[] {
  const fields = output.split("\0");
  const entries: { xy: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    entries.push({ xy: entry.slice(0, 2), path: entry.slice(3) });
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return entries;
}

/** Read-only facts about a task branch, or the reason it cannot be evaluated safely. */
type Probe =
  | {
      kind: "skip";
      reason: string;
      baseRef: string | null;
      baseTip: string | null;
      head: string | null;
    }
  | {
      kind: "facts";
      path: string;
      baseRef: string;
      baseTip: string;
      head: string;
      behind: number;
      /** The branch has no commits of its own beyond the base: a fast-forward suffices. */
      fastForward: boolean;
      /** For a true merge: the merged tree, or the files that would conflict. */
      merge: { tree: string | null; conflicts: string[] } | null;
    };

export interface BranchSyncerOptions {
  store: Store;
  workspaces: WorkspaceManager;
  /** Defaults to the real git; tests substitute a fake. */
  git?: GitRunner;
  live: LiveConfig;
  logger: Logger;
  maxTasksPerTick: number;
  /** Serializes with every other action on the task (launch, resume, accept...). */
  withTaskLock: <T>(taskId: string, fn: () => Promise<T>) => Promise<T>;
  /** Test hook at points inside a refresh; may throw SimulatedCrash. */
  at?: (point: SyncPoint, taskId: string) => void;
}

export class BranchSyncer {
  private readonly o: BranchSyncerOptions;
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  private readonly git: GitRunner;

  constructor(o: BranchSyncerOptions) {
    this.o = o;
    this.git = o.git ?? systemGit;
  }

  private text(cwd: string, args: string[], options?: { trim?: boolean }): Promise<string> {
    return gitText(this.git, cwd, args, options);
  }

  private async succeeds(cwd: string, args: string[]): Promise<boolean> {
    return (await this.git.run(args, { cwd })).code === 0;
  }

  private get store(): Store {
    return this.o.store;
  }

  /**
   * One bounded pass: the least recently checked open tasks with worktrees, one
   * at a time, each under its task lock. Stops early when the supervisor stops.
   */
  async tick(stopped: () => boolean): Promise<void> {
    const candidates = this.store
      .rowsInStates([...OPEN_STATES])
      .filter((row) => row.workspacePath)
      .map((row) => this.store.toTask(row))
      .filter((task) => this.modeFor(task) !== "off")
      .sort((a, b) => (a.branchSync?.checkedAt ?? "").localeCompare(b.branchSync?.checkedAt ?? ""))
      .slice(0, this.o.maxTasksPerTick);
    for (const task of candidates) {
      if (stopped()) return;
      try {
        await this.o.withTaskLock(task.id, () => this.syncLocked(task.id, "periodic"));
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        this.o.logger.error({ err: error, taskId: task.id }, "branch sync failed");
      }
    }
  }

  private modeFor(task: Task) {
    return this.o.live.branchSyncMode(task.repo, this.store.getRepo(task.repo) !== null);
  }

  /** Checks one task and refreshes it when the mode and trigger allow. The caller holds the task lock. */
  async syncLocked(taskId: string, trigger: SyncTrigger): Promise<SyncOutcome> {
    const task = this.store.getTask(taskId);
    if (!task || !OPEN_STATES.has(task.state) || !task.workspacePath) return NONE;
    const mode = this.modeFor(task);
    if (mode === "off") return NONE;
    const repo = this.store.requireRepo(task.repo, { includeRetired: true });
    const previous = task.branchSync;
    let status: BranchSync;
    let outcome: SyncOutcome = NONE;
    try {
      const recovered = await this.recoverIntent(task, previous);
      const current = recovered ?? task;
      const probe = await this.probe(current, repo, previous);
      status = this.statusFrom(probe, previous, recovered?.branchSync ?? null);
      if (probe.kind === "facts" && probe.behind > 0 && status.state === "behind") {
        const why =
          mode === "detect"
            ? "detect-only mode (branchSync: refresh updates it)"
            : deferral(current.state, trigger);
        if (why) status.reason = `${status.reason}; ${why}.`;
        else {
          outcome = await this.withRepoLock(repo.id, () =>
            this.refresh(current, probe, status, trigger),
          );
          status = outcome.status!;
        }
      }
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      this.o.logger.warn({ err: error, taskId }, "branch sync check failed");
      status = {
        // The stored record, not `previous`: an intent may have been settled above.
        ...this.blank(this.store.requireTask(taskId).branchSync),
        state: "error",
        reason: truncate(redact(`Branch sync failed: ${(error as Error).message}`), 500),
      };
    }
    this.record(this.store.requireTask(taskId), status);
    return { ...outcome, status };
  }

  private blank(previous: BranchSync | null): BranchSync {
    return {
      state: "skipped",
      reason: "",
      baseRef: null,
      baseTip: null,
      head: null,
      behind: null,
      conflictFiles: [],
      checkedAt: this.store.now(),
      // Kept through skips and errors so a conflict is not reported twice.
      conflictReported: previous?.conflictReported ?? null,
      intent: previous?.intent ?? null,
      lastRefresh: previous?.lastRefresh ?? null,
    };
  }

  private statusFrom(
    probe: Probe,
    previous: BranchSync | null,
    recovered: BranchSync | null,
  ): BranchSync {
    const base = this.blank(recovered ?? previous);
    if (probe.kind === "skip") {
      return {
        ...base,
        baseRef: probe.baseRef,
        baseTip: probe.baseTip,
        head: probe.head,
        reason: `Not checked: ${probe.reason}.`,
      };
    }
    const filled = {
      ...base,
      baseRef: probe.baseRef,
      baseTip: probe.baseTip,
      head: probe.head,
      behind: probe.behind,
    };
    if (probe.behind === 0)
      return {
        ...filled,
        state: "current",
        reason: `Up to date with ${probe.baseRef} (${short(probe.baseTip)}).`,
      };
    const conflicts = probe.merge?.conflicts ?? [];
    if (conflicts.length > 0) {
      return {
        ...filled,
        state: "conflict",
        conflictFiles: conflicts.slice(0, MAX_LISTED_FILES),
        reason: `${probe.behind} commit(s) behind ${probe.baseRef} (${short(probe.baseTip)}); merging it would conflict in ${listFiles(conflicts)}. Left unchanged; OCD never resolves conflicts.`,
      };
    }
    return {
      ...filled,
      state: "behind",
      reason: `${probe.behind} commit(s) behind ${probe.baseRef} (${short(probe.baseTip)})`,
    };
  }

  /** Persists the status and keeps the conflict attention item in step with it. */
  private record(task: Task, status: BranchSync): void {
    const key = branchSyncAttentionKey(task.id);
    const pair = status.head && status.baseTip ? `${status.head}:${status.baseTip}` : null;
    this.store.tx(() => {
      if (status.state === "conflict") {
        // Reported once per (branch head, base tip) and only while nobody is
        // working on the branch; a live worker may still change it.
        const idle = !LIVE_STATES.has(task.state) && task.state !== "manual";
        if (idle && pair && status.conflictReported !== pair) {
          const reason = `Task ${task.id} ("${truncate(task.title, 80)}") is ${status.reason} To integrate ${status.baseRef}, send the worker a follow-up asking it to merge ${status.baseRef} and resolve the conflicts, or resolve them by hand in ${task.workspacePath}.`;
          const { attention, created } = this.store.raiseAttention(
            {
              taskId: task.id,
              kind: "decision",
              dedupeKey: key,
              reason: truncate(redact(reason), 2000),
              resolvableBy: "manager",
              operation: {
                branchSync: { baseRef: status.baseRef, baseTip: status.baseTip, head: status.head },
              },
            },
            { notify: true, wake: true },
          );
          if (!created)
            this.store.updateAttentionReason(attention.id, truncate(redact(reason), 2000));
          this.store.appendEvent(task.id, "branch_sync.conflict", {
            baseRef: status.baseRef,
            baseTip: status.baseTip,
            head: status.head,
            files: status.conflictFiles,
          });
          status.conflictReported = pair;
        }
      } else if (status.state === "current") {
        status.conflictReported = null;
        this.store.settleOpenAttention(key, "resolved");
      }
      this.store.setBranchSync(task.id, status);
    });
  }

  /**
   * Finishes or drops a refresh that a crash interrupted: the git write either
   * happened (HEAD is the intended commit) or it did not (HEAD unchanged).
   */
  private async recoverIntent(task: Task, previous: BranchSync | null): Promise<Task | null> {
    if (!previous?.intent || !task.workspacePath || !existsSync(task.workspacePath)) return null;
    const { intent } = previous;
    const head = await this.text(task.workspacePath, ["rev-parse", "HEAD"]).catch(() => null);
    const cleared: BranchSync = { ...previous, intent: null };
    if (head === intent.to) {
      const lastRefresh = { ...intent, at: this.store.now(), trigger: "recovered" };
      this.store.patchTask(
        task.id,
        { baseRef: intent.baseTip, branchSync: { ...cleared, lastRefresh } },
        { type: "branch_sync.refreshed", data: { ...lastRefresh, previousBase: task.baseRef } },
      );
    } else {
      this.store.setBranchSync(task.id, cleared);
      this.store.appendEvent(task.id, "branch_sync.intent_dropped", { ...intent, head });
    }
    return this.store.requireTask(task.id);
  }

  /** Read-only: ownership, git state, the base, and what a merge would do. */
  private async probe(task: Task, repo: Repository, previous: BranchSync | null): Promise<Probe> {
    const skip = (reason: string, extra: { baseTip?: string; head?: string } = {}): Probe => ({
      kind: "skip",
      reason,
      baseRef: repo.baseRef,
      baseTip: null,
      head: null,
      ...extra,
    });
    const owned = await this.ownership(task, repo);
    if (typeof owned !== "string") return skip(owned.problem);
    const path = owned;
    const busy = await this.inProgress(path);
    if (busy)
      return skip(`a git operation is in progress in the worktree (${busy}); finish or abort it`);
    const branchRef = `refs/heads/${this.o.workspaces.branchFor(task.id)}`;
    const headRef = (
      await this.git.run(["symbolic-ref", "-q", "HEAD"], { cwd: path })
    ).stdout.trim();
    if (headRef !== branchRef)
      return skip(`the worktree has ${headRef || "a detached HEAD"} checked out, not ${branchRef}`);
    const head = await this.text(path, ["rev-parse", "HEAD"]);
    if (!repo.baseRef)
      return skip(
        `repos.${repo.name}.baseRef is not set, so there is no integration branch to track`,
        { head },
      );
    const fullName = (
      await this.git.run(["rev-parse", "--symbolic-full-name", repo.baseRef], { cwd: repo.path })
    ).stdout.trim();
    if (fullName.startsWith("refs/heads/ocd/"))
      return skip(
        `baseRef ${repo.baseRef} is an OCD task branch; only an integration branch is tracked`,
        { head },
      );
    const tip = await this.git.run(
      ["rev-parse", "--verify", "--quiet", `${repo.baseRef}^{commit}`],
      {
        cwd: repo.path,
      },
    );
    if (tip.code !== 0)
      return skip(`baseRef ${repo.baseRef} does not resolve to a commit`, { head });
    const baseTip = tip.stdout.trim();
    const behind = Number(await this.text(path, ["rev-list", "--count", `HEAD..${baseTip}`]));
    const facts = {
      kind: "facts" as const,
      path,
      baseRef: repo.baseRef,
      baseTip,
      head,
      behind,
      fastForward: false,
      merge: null,
    };
    if (behind === 0) return facts;
    if (
      !task.baseRef ||
      !(await this.succeeds(path, ["merge-base", "--is-ancestor", task.baseRef, baseTip]))
    ) {
      return skip(
        `the task started from ${task.baseRef ? short(task.baseRef) : "an unknown base"}, which is not in ${repo.baseRef} any more (rewritten or retargeted); not merging unrelated history`,
        { baseTip, head },
      );
    }
    if (await this.succeeds(path, ["merge-base", "--is-ancestor", "HEAD", baseTip]))
      return { ...facts, fastForward: true };
    // The same pair already conflicted: do not recompute (or report) it again.
    if (previous?.state === "conflict" && previous.head === head && previous.baseTip === baseTip)
      return { ...facts, merge: { tree: null, conflicts: previous.conflictFiles } };
    return { ...facts, merge: await this.predictMerge(path, head, baseTip) };
  }

  /** The task's worktree path if OCD owns it, or why it does not. */
  private async ownership(task: Task, repo: Repository): Promise<string | { problem: string }> {
    const branch = this.o.workspaces.branchFor(task.id);
    if (task.branch !== branch)
      return { problem: `the task branch is ${task.branch ?? "unknown"}, not ${branch}` };
    const recorded = task.workspacePath!;
    if (!existsSync(recorded)) return { problem: `the worktree ${recorded} is missing` };
    if (!existsSync(repo.path)) return { problem: `the repository ${repo.path} is missing` };
    const path = realpathSync(recorded);
    const expected = this.o.workspaces.pathFor(repo.name, task.id);
    if (path !== (existsSync(expected) ? realpathSync(expected) : expected))
      return { problem: `${recorded} is not OCD's worktree for this task` };
    if (path === realpathSync(repo.path))
      return { problem: "the path is the repository's primary checkout" };
    const list = await this.text(repo.path, ["worktree", "list", "--porcelain"]);
    const registered = list.split("\n\n").some((block) => {
      const lines = block.split("\n");
      const at = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      return (
        at !== undefined &&
        existsSync(at) &&
        realpathSync(at) === path &&
        lines.includes(`branch refs/heads/${branch}`)
      );
    });
    return registered
      ? path
      : { problem: `${path} is not registered as the ${branch} worktree of ${repo.name}` };
  }

  private async inProgress(path: string): Promise<string | null> {
    const gitDir = await this.text(path, ["rev-parse", "--absolute-git-dir"]);
    return IN_PROGRESS.find((name) => existsSync(join(gitDir, name))) ?? null;
  }

  /** Merges in memory (git merge-tree): nothing in the worktree, index or refs changes. */
  private async predictMerge(path: string, head: string, baseTip: string) {
    const result = await this.git.run(
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", head, baseTip],
      {
        cwd: path,
      },
    );
    const lines = result.stdout.split("\n").filter(Boolean);
    if (result.code === 0) return { tree: lines[0] ?? null, conflicts: [] };
    if (result.code === 1 && lines.length > 1)
      return { tree: null, conflicts: [...new Set(lines.slice(1))] };
    throw new Error(`git merge-tree failed: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Uncommitted or untracked entries, and ignored ones (which a checkout would overwrite silently). */
  private async worktreeFiles(path: string) {
    const out = await this.text(
      path,
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignored=matching",
      ],
      { trim: false },
    );
    const entries = statusEntries(out);
    return {
      dirty: entries.filter((e) => e.xy !== "!!").map((e) => e.path),
      ignored: entries.filter((e) => e.xy === "!!").map((e) => e.path),
    };
  }

  /**
   * Brings the branch up to date with the base: a fast-forward when the branch
   * has no commits of its own, otherwise a merge commit built from the merge
   * already computed in memory. Either way the worktree only ever moves by
   * `git merge --ff-only`, which refuses to overwrite local changes, so a
   * failure leaves it as it was. Everything is re-checked just before writing.
   */
  private async refresh(
    task: Task,
    probe: Extract<Probe, { kind: "facts" }>,
    status: BranchSync,
    trigger: SyncTrigger,
  ): Promise<SyncOutcome> {
    const deferred = (why: string): SyncOutcome => ({
      status: { ...status, reason: `${status.reason}; not refreshed: ${why}.` },
      refreshed: false,
      note: null,
    });
    const { path, head, baseTip, baseRef } = probe;
    const files = await this.worktreeFiles(path);
    if (files.dirty.length > 0)
      return deferred(
        `${files.dirty.length} uncommitted or untracked file(s) (${listFiles(files.dirty)}); commit or remove them, OCD never stashes`,
      );
    const method: "fast-forward" | "merge" = probe.fastForward ? "fast-forward" : "merge";
    const targetTree = probe.fastForward ? baseTip : probe.merge?.tree;
    if (!targetTree) return deferred("the merge result is unknown");
    const touched = (
      await this.text(path, ["diff", "--name-only", "-z", head, targetTree], { trim: false })
    )
      .split("\0")
      .filter(Boolean);
    const clobbered = touched.filter((file) =>
      files.ignored.some(
        (ignored) => file === ignored || (ignored.endsWith("/") && file.startsWith(ignored)),
      ),
    );
    if (clobbered.length > 0)
      return deferred(
        `it would overwrite ignored file(s) ${listFiles(clobbered)}; move them aside first`,
      );

    // Re-check everything a concurrent actor could have changed since the probe.
    this.o.at?.("before_branch_sync_recheck", task.id);
    const fresh = this.store.getTask(task.id);
    if (!fresh || fresh.state !== task.state || deferral(fresh.state, trigger))
      return deferred(`the task became ${fresh?.state ?? "missing"}`);
    const busy = await this.inProgress(path);
    if (busy) return deferred(`a git operation started in the worktree (${busy})`);
    if ((await this.text(path, ["rev-parse", "HEAD"])) !== head)
      return deferred("the branch moved while checking; retried next time");
    const tip = await this.git.run(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: path,
    });
    if (tip.stdout.trim() !== baseTip)
      return deferred(`${baseRef} moved while checking; retried next time`);
    if ((await this.worktreeFiles(path)).dirty.length > 0)
      return deferred("files changed while checking");

    const target = probe.fastForward
      ? baseTip
      : await this.text(path, [
          "commit-tree",
          targetTree,
          "-p",
          head,
          "-p",
          baseTip,
          "-m",
          `Merge ${baseRef} into ${task.branch}\n\nOCD branch sync: ${baseRef} at ${baseTip}, merged without conflicts\n(trigger: ${trigger}). Nothing was rebased, pushed or resolved.`,
        ]);
    const intent = { from: head, to: target, baseTip, method } as const;
    this.store.tx(() => {
      this.store.setBranchSync(task.id, { ...status, intent });
      this.store.appendEvent(task.id, "branch_sync.intent", { ...intent, baseRef, trigger });
    });
    // Repository hooks are not run from the daemon (core.hooksPath=/dev/null).
    const result = await this.git.run(
      ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--quiet", target],
      { cwd: path },
    );
    this.o.at?.("after_branch_sync_write", task.id);
    const now = (await this.text(path, ["rev-parse", "HEAD"]).catch(() => null)) ?? "unknown";
    if (result.code !== 0 || now !== target) {
      const message = truncate(
        redact((result.stderr || result.stdout).trim() || `HEAD is ${now}`),
        300,
      );
      this.store.appendEvent(task.id, "branch_sync.failed", { ...intent, head: now, message });
      return {
        status: {
          ...status,
          state: "error",
          head: now,
          intent: null,
          reason:
            now === head
              ? `Refresh from ${baseRef} failed and nothing changed: ${message}`
              : `Refresh from ${baseRef} failed and the branch is now at ${short(now)}; inspect ${path}: ${message}`,
        },
        refreshed: false,
        note: null,
      };
    }
    const lastRefresh = { at: this.store.now(), from: head, to: target, baseTip, method, trigger };
    const done: BranchSync = {
      ...status,
      state: "current",
      head: target,
      behind: 0,
      intent: null,
      conflictReported: null,
      lastRefresh,
      reason: `Up to date with ${baseRef} (${short(baseTip)}); ${method === "merge" ? "merged" : "fast-forwarded"} by OCD (${trigger}).`,
    };
    // The recorded base moves with the branch, so verification keeps showing only the task's own changes.
    this.store.patchTask(
      task.id,
      { baseRef: baseTip, branchSync: done },
      {
        type: "branch_sync.refreshed",
        data: { ...lastRefresh, baseRef, previousBase: task.baseRef },
      },
    );
    const note = `Before this instruction OCD brought ${task.branch} up to date with ${baseRef} (${short(baseTip)}) by a ${method} without conflicts. Build on the updated branch and re-run the relevant checks.`;
    return { status: done, refreshed: true, note };
  }

  /** Serializes git writes per repository; worktrees of one repo share refs and objects. */
  private withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(repoId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.repoLocks.set(repoId, settled);
    void settled.then(() => {
      if (this.repoLocks.get(repoId) === settled) this.repoLocks.delete(repoId);
    });
    return next;
  }
}
