import { join } from "node:path";

import {
  API_VERSION,
  DispatchTaskInput,
  LIVE_STATES,
  PeekTaskInput,
  REPORT_INSTRUCTIONS,
  TAKEOVER_STATES,
  TRANSCRIPT_LIMITS,
  TRANSCRIPT_NOTICE,
  entrySize,
  sanitizeEntry,
  workerOcdEnv,
  parseWorkerReport,
  redact,
  truncate,
  type Actor,
  type AdapterStatus,
  type Attention,
  type AttentionResponse,
  type GitHubCliStatus,
  type HarnessName,
  type LandPlan,
  type LandResult,
  type TaskDiff,
  type ShutdownReport,
  type SupervisorStatus,
  type TakeOverResult,
  type Task,
  type TaskProgress,
  type TaskResult,
  type TodoItem,
  type TaskTranscript,
  type WorkerReport,
  type TranscriptEntry,
  type WorkerRun,
} from "@ocd/core";
import {
  HarnessUnavailableError,
  InvalidCursorError,
  requireCapability,
  type AdapterEvent,
  type HarnessAdapter,
  type SessionSnapshot,
  type SessionSpec,
  type TranscriptPage,
} from "@ocd/adapters";
import type { z } from "zod";

import {
  BranchSyncer,
  branchSyncAttentionKey,
  type SyncPoint,
  type SyncTrigger,
} from "./branch-sync.ts";
import type { LiveConfig, SupervisorConfig } from "./config.ts";
import type { MergeMethod, PullRequestHost } from "./pull-requests.ts";
import { ApiError, SimulatedCrash, badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { iso, type Clock } from "./ids.ts";
import type { Logger } from "./logger.ts";
import type { MemoryService } from "./memory.ts";
import { changedFilesText, notification, type Notice } from "./notification.ts";
import type { OutboxWorker } from "./outbox.ts";
import type { AttentionInput, Store } from "./store.ts";
import { WorkspaceError, filteredEnv, type WorkspaceManager } from "./workspace.ts";

export type CrashPoint =
  | "after_intent"
  | "after_workspace"
  | "after_session_created"
  | "after_session_persisted"
  | "after_prompt"
  | SyncPoint;

export interface SupervisorHooks {
  /** Test hook: throw SimulatedCrash to stop the supervisor at a crash boundary. */
  at?: (point: CrashPoint, taskId: string) => void;
  /** Test hook: how long a transcript read may take (default 10s). */
  peekTimeoutMs?: number;
}

export interface SupervisorOptions {
  /** Per-task OCD homes for workers (see workerOcdEnv); never the live home. */
  sandboxRoot: string;
  store: Store;
  config: SupervisorConfig;
  adapters: HarnessAdapter[];
  workspaces: WorkspaceManager;
  memory: MemoryService;
  outbox: OutboxWorker;
  logger: Logger;
  clock: Clock;
  instanceId: string;
  hooks?: SupervisorHooks;
  live: LiveConfig;
  /** Opens pull requests on request; absent means the PR tool is unavailable. */
  pullRequests?: PullRequestHost;
  /** Called when a simulated crash fires; the daemon tears down without cleanup. */
  onCrash?: (error: SimulatedCrash) => void;
  /** A task's work reached its repository's base branch (direct push or merged PR). */
  onLanded?: (repo: string) => void;
}

const INTERACTION_KINDS = ["permission", "question"] as const;
const PEEK_TIMEOUT_MS = 10_000;

/** Worker-written text is stored and published (PR bodies): redact and bound it. */
function sanitizeReport(report: WorkerReport): WorkerReport {
  const clean = (text: string, max: number) => truncate(redact(text), max);
  return {
    ...report,
    summary: clean(report.summary, 4000),
    tests: report.tests.map((t) => ({
      ...t,
      command: clean(t.command, 500),
      ...(t.details !== undefined ? { details: clean(t.details, 2000) } : {}),
    })),
    unresolved: report.unresolved.map((u) => clean(u, 2000)),
  };
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

interface PeekCursor {
  /** Task and session the cursor was issued for. */
  t: string;
  s: string;
  /** The adapter's own cursor. */
  b: string;
}

function encodeCursor(cursor: PeekCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): PeekCursor | null {
  try {
    const c = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<PeekCursor>;
    return typeof c.t === "string" && typeof c.s === "string" && typeof c.b === "string"
      ? { t: c.t, s: c.s, b: c.b }
      : null;
  } catch {
    return null;
  }
}
const ACTIVITY_WRITE_INTERVAL_MS = 10_000;
const HARNESS_RETRY_MS = 30_000;
/** Checklists kept in memory (most recently updated tasks), and events per progress view. */
const TODO_TASKS_MAX = 100;
const PROGRESS_EVENTS = 40;

export class Supervisor {
  private readonly adapters = new Map<HarnessName, HarnessAdapter>();
  private readonly versions = new Map<HarnessName, AdapterStatus>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly taskLocks = new Map<string, Promise<unknown>>();
  private readonly lastActivityWrite = new Map<string, number>();
  private readonly harnessRetryAt = new Map<HarnessName, number>();
  private github: GitHubCliStatus | null = null;
  private githubProbes = 0;
  /** Latest checklist per task. Progress display only: not persisted, not orchestration state. */
  private readonly todos = new Map<string, { items: TodoItem[]; at: string }>();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** Worktrees automatic cleanup kept because work would be lost; not retried until restart. */
  private readonly keptByAutoCleanup = new Set<string>();
  private syncing: Promise<void> | null = null;
  private readonly branchSync: BranchSyncer;
  private lastReconcileTick = 0;
  /** After a wake from sleep, stall clocks restart from here. */
  private activityBaseline = 0;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  readonly startedAt: string;

  private readonly o: SupervisorOptions;

  constructor(o: SupervisorOptions) {
    this.o = o;
    for (const adapter of o.adapters) this.adapters.set(adapter.harness, adapter);
    this.startedAt = iso(o.clock());
    this.branchSync = new BranchSyncer({
      store: o.store,
      workspaces: o.workspaces,
      live: o.live,
      logger: o.logger.child({ component: "branch-sync" }),
      maxTasksPerTick: o.config.branchSync.maxTasksPerTick,
      withTaskLock: (taskId, fn) => this.withTaskLock(taskId, fn),
      at: (point, taskId) => this.crashPoint(point, taskId),
    });
  }

  private get store(): Store {
    return this.o.store;
  }

  private get log(): Logger {
    return this.o.logger;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      const status = await adapter.probe().catch((error: unknown): AdapterStatus => ({
        harness: adapter.harness,
        available: false,
        version: null,
        problems: [String(error)],
      }));
      this.versions.set(adapter.harness, status);
      this.log.info({ harness: adapter.harness, status }, "adapter probed");
      this.unsubscribers.push(
        adapter.subscribe((event) => void this.onAdapterEvent(adapter, event)),
      );
    }
    await this.reconcile("startup");
    this.lastReconcileTick = this.o.clock();
    this.activityBaseline = this.o.clock();
    this.schedulerTimer = setInterval(() => void this.tick(), this.o.config.schedulerIntervalMs);
    this.reconcileTimer = setInterval(
      () => void this.periodicReconcile(),
      this.o.config.reconcileIntervalMs,
    );
    // Cheap when every repository is off: no git command runs.
    this.syncTimer = setInterval(
      () => void this.syncBranches(),
      this.o.config.branchSync.intervalMs,
    );
    // Finished tasks' worktrees, when autoCleanup is on: hourly, never forced.
    this.cleanupTimer = setInterval(() => void this.autoCleanup(), 3_600_000);
    this.cleanupTimer.unref();
    this.o.outbox.start();
    void this.tick();
    // Diagnostics only: startup never waits for gh or the network.
    void this.probeGithub();
  }

  /**
   * Read-only check of the gh CLI behind pull requests (bounded, no prompts).
   * Logged and shown in status; never fatal, and PR actions resolve gh again.
   */
  async probeGithub(): Promise<GitHubCliStatus | null> {
    const host = this.o.pullRequests;
    if (!host?.probe) return null;
    const probe = ++this.githubProbes;
    try {
      const status = await host.probe();
      // A slower, older check (e.g. before gh.binary was saved) must not win.
      if (this.stopped || probe !== this.githubProbes) return status;
      this.github = status;
      if (status.problems.length)
        this.log.warn(
          { github: status },
          "GitHub CLI check found a problem; pull requests may fail",
        );
      else this.log.info({ github: status }, "GitHub CLI ready");
      return status;
    } catch (error) {
      this.log.warn({ err: error }, "GitHub CLI check failed");
      return null;
    }
  }

  private clearTimers(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.schedulerTimer = null;
    this.reconcileTimer = null;
    this.syncTimer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  /**
   * Graceful stop. Service-owned sessions keep running and are reconciled on
   * restart; workers that die with the supervisor are interrupted and recorded.
   */
  async stop(): Promise<ShutdownReport> {
    this.stopped = true;
    this.clearTimers();
    await this.ticking;
    // A branch sync in flight finishes its current task (bounded git commands), then stops.
    await this.syncing;
    const report: ShutdownReport = {
      workerPolicy:
        "Service-owned workers (OpenCode) keep running and are reconciled on restart. Workers owned by the supervisor process are interrupted; their session IDs are kept for an explicit resume.",
      workers: [],
    };
    for (const row of this.store.rowsInStates([...LIVE_STATES])) {
      const adapter = this.adapters.get(row.harness);
      if (adapter?.sessionsSurviveSupervisor) {
        report.workers.push({
          taskId: row.id,
          harness: row.harness,
          sessionId: row.sessionId,
          outcome: "left running in harness service",
        });
        continue;
      }
      if (adapter && row.sessionId)
        await adapter.interrupt({ sessionId: row.sessionId }).catch(() => undefined);
      const run = this.store.latestRun(row.id);
      if (run)
        this.store.updateRun(run.id, {
          state: "ended",
          endedAt: this.store.now(),
          exitReason: "supervisor_shutdown",
        });
      this.store.transition(row.id, "interrupted", {
        event: { type: "shutdown.interrupted", data: { sessionId: row.sessionId } },
        attention: [
          this.attentionFor(
            { id: row.id, harness: row.harness, sessionId: row.sessionId },
            "failure",
            `shutdown:${run?.id ?? "none"}`,
            `The supervisor stopped and interrupted this worker (session ${row.sessionId ?? "none"}). The workspace is preserved; resume explicitly.`,
            "human",
            { headline: "Task interrupted", detail: "OCD stopped mid-run; resume explicitly" },
          ),
        ],
      });
      report.workers.push({
        taskId: row.id,
        harness: row.harness,
        sessionId: row.sessionId,
        outcome: "interrupted; resume explicitly",
      });
    }
    await this.o.outbox.stop();
    await this.o.outbox.flush().catch(() => undefined);
    for (const adapter of this.adapters.values()) await adapter.close().catch(() => undefined);
    this.log.info({ report }, "supervisor stopped");
    return report;
  }

  /** Abrupt halt used for simulated crashes: no state changes, no cleanup. */
  halt(): void {
    this.stopped = true;
    this.clearTimers();
    void this.o.outbox.stop();
  }

  private crashPoint(point: CrashPoint, taskId: string): void {
    this.o.hooks?.at?.(point, taskId);
  }

  private handleCrash(error: unknown): boolean {
    if (error instanceof SimulatedCrash) {
      this.halt();
      this.o.onCrash?.(error);
      return true;
    }
    return false;
  }

  /** Serializes work per task so events, reconciliation, and API calls do not interleave. */
  private withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.taskLocks.set(taskId, settled);
    void settled.then(() => {
      if (this.taskLocks.get(taskId) === settled) this.taskLocks.delete(taskId);
    });
    return next;
  }

  private adapterFor(harness: HarnessName): HarnessAdapter {
    const adapter = this.adapters.get(harness);
    if (!adapter) {
      this.assertHarnessEnabled(harness);
      throw new ApiError(422, "harness_unavailable", `No ${harness} adapter is configured`);
    }
    return adapter;
  }

  /** Claude Code and Codex are opt-in: name the setting when one is off. */
  private assertHarnessEnabled(harness: HarnessName): void {
    if ((harness === "claude" || harness === "codex") && !this.o.config[harness].enabled)
      throw new ApiError(
        422,
        "harness_disabled",
        `${harness === "claude" ? "Claude Code" : "Codex"} is off; set "${harness}": { "enabled": true } in ocd.jsonc and restart the supervisor`,
      );
  }

  // ---------------------------------------------------------------------------
  // Status and controls

  status(): SupervisorStatus {
    return {
      apiVersion: API_VERSION,
      pid: process.pid,
      instanceId: this.o.instanceId,
      startedAt: this.startedAt,
      paused: this.isPaused(),
      concurrency: this.o.config.concurrency,
      counts: this.store.countByState(),
      openAttention: this.store.countOpenAttention(),
      outbox: this.store.outboxCounts(),
      manager: this.store.activeManager(),
      adapters: [...this.versions.values()],
      github: this.github,
      pullRequests: this.o.pullRequests !== undefined,
    };
  }

  isPaused(): boolean {
    return this.store.getSetting("paused", false);
  }

  /** Pause stops new dispatch; running workers continue. */
  setPaused(paused: boolean): void {
    this.store.setSetting("paused", paused);
    this.log.info({ paused }, "dispatch pause changed");
    if (!paused) void this.tick();
  }

  // ---------------------------------------------------------------------------
  // Dispatch and admission

  dispatch(input: z.output<typeof DispatchTaskInput>): { task: Task; created: boolean } {
    const repo = this.store.requireRepo(input.repo);
    const profileName = input.profile ?? repo.defaultProfile;
    if (!profileName)
      throw badRequest(
        "profile_required",
        `Repository ${repo.name} has no default profile; choose one`,
      );
    const profile = this.o.live.getProfile(profileName);
    if (!profile) throw notFound(`Profile ${profileName} (declare it in ocd.jsonc)`);
    this.assertHarnessUsable(profile.harness);
    const result = this.store.createTask({
      idempotencyKey: input.idempotencyKey,
      repo,
      profile,
      title: input.title,
      instructions: input.instructions,
      acceptanceCriteria: input.acceptanceCriteria,
      dependsOn: input.dependsOn,
    });
    if (result.created) {
      this.log.info(
        { taskId: result.task.id, repo: repo.name, profile: profile.name },
        "task queued",
      );
      void this.tick();
    }
    return result;
  }

  private assertHarnessUsable(harness: HarnessName): void {
    if (harness === "fake" && !this.o.config.allowFakeHarness) {
      throw new ApiError(
        422,
        "harness_unsupported",
        "The fake harness is disabled (allowFakeHarness)",
      );
    }
    const adapter = this.adapters.get(harness);
    if (!adapter) {
      this.assertHarnessEnabled(harness);
      throw new ApiError(
        422,
        "harness_unsupported",
        `Harness ${harness} is not supported in this version`,
      );
    }
    requireCapability(adapter, "start");
    const status = this.versions.get(harness);
    if (status && !status.available) {
      throw new ApiError(
        422,
        "harness_unavailable",
        `Harness ${harness} is unavailable: ${status.problems.join("; ")}`,
      );
    }
  }

  /** Admits queued work within capacity. Serial launches keep side effects ordered. */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.ticking ??= this.admit()
      .catch((error: unknown) => {
        if (!this.handleCrash(error)) this.log.error({ err: error }, "scheduler tick failed");
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  /**
   * One branch-sync pass (docs/branch-sync.md). Never overlaps itself; runs on
   * a timer and may be called directly (tests).
   */
  syncBranches(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.syncing ??= this.branchSync
      .tick(() => this.stopped)
      .catch((error: unknown) => {
        if (!this.handleCrash(error)) this.log.error({ err: error }, "branch sync pass failed");
      })
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  /**
   * Refreshes the task branch at a lifecycle boundary when its repository opted
   * in. The caller holds the task lock. A sync problem never blocks the action;
   * it shows up in the task's branch-sync status instead.
   */
  private async syncAtBoundary(taskId: string, trigger: SyncTrigger): Promise<string | null> {
    try {
      return (await this.branchSync.syncLocked(taskId, trigger)).note;
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      this.log.warn({ err: error, taskId, trigger }, "branch sync at a boundary failed");
      return null;
    }
  }

  private async admit(): Promise<void> {
    if (this.isPaused()) return;
    for (const row of this.store.queuedTasks()) {
      if (this.stopped || this.isPaused()) return;
      const live = this.store.rowsInStates([...LIVE_STATES]).length;
      if (live >= this.o.config.concurrency) return;
      // A harness that just refused connections is retried later, not hammered.
      if ((this.harnessRetryAt.get(row.harness) ?? 0) > this.o.clock()) continue;
      try {
        await this.admitOne(row.id);
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        // One bad task must not starve the rest of the queue.
        this.log.error({ err: error, taskId: row.id }, "admission failed");
      }
    }
  }

  private async admitOne(taskId: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!this.adapters.has(task.harness)) {
      this.store.transition(taskId, "needs_attention", {
        from: ["queued"],
        attention: [
          this.attentionFor(
            task,
            "failure",
            "no-adapter",
            `Harness ${task.harness} is not configured in this supervisor; the task cannot start.`,
            "human",
            { headline: "Task can't start", detail: `Harness ${task.harness} is not configured` },
          ),
        ],
      });
      return;
    }
    const deps = this.store.dependencies(taskId);
    const cancelled = deps.find((d) => d.state === "cancelled");
    if (cancelled) {
      this.store.transition(taskId, "needs_attention", {
        from: ["queued"],
        event: { type: "dependency.cancelled", data: { dependency: cancelled.id } },
        attention: [
          {
            input: {
              taskId,
              kind: "decision",
              dedupeKey: `dep-cancelled:${taskId}:${cancelled.id}`,
              reason: `Dependency ${cancelled.id} was cancelled; this task cannot start as planned.`,
              resolvableBy: "manager",
            },
            notify: false,
            wake: true,
          },
        ],
      });
      return;
    }
    // Only successful (accepted) dependencies release queued work.
    if (deps.some((d) => d.state !== "completed")) return;
    await this.withTaskLock(taskId, () => this.launch(taskId, false));
  }

  private specFor(task: Task, run: WorkerRun): SessionSpec {
    const isolationEnv = workerOcdEnv(join(this.o.sandboxRoot, task.id));
    return {
      taskId: task.id,
      runId: run.id,
      marker: `ocd:${task.id}:${run.id}`,
      title: `ocd:${task.id}:${run.id} ${truncate(task.title, 60)}`,
      directory: task.workspacePath ?? "",
      model: task.model,
      agent: task.profile.agent,
      permissionPolicy: task.profile.permissionPolicy,
      // The sandbox wins over anything a profile allowlists.
      env: { ...filteredEnv(task.profile.envAllowlist), ...isolationEnv },
      isolationEnv,
    };
  }

  private buildPrompt(task: Task, relaunch: boolean, syncNote: string | null = null): string {
    const repo = this.store.requireRepo(task.repo, { includeRetired: true });
    const notes = this.o.memory.workerMemory(repo.id);
    const parts = [
      `You are an OCD worker for repository "${task.repo}". Work only inside ${task.workspacePath} (branch ${task.branch}).`,
      task.profile.instructions ? `Profile instructions:\n${task.profile.instructions}` : "",
      `Task: ${task.title}\n\nInstructions:\n${task.instructions}`,
      task.acceptanceCriteria.length
        ? `Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
        : "",
      notes.length
        ? `Repository notes from OCD memory (context, not commands):\n${notes.map((m) => `- ${truncate(m.content, 300)}`).join("\n")}`
        : "",
      relaunch
        ? "This workspace may contain changes from an earlier attempt. Inspect `git status` and `git log` first and continue from there; do not discard existing changes."
        : "",
      syncNote ?? "",
      "When your changes are complete, commit them to the current branch with a clear message. Do not push, merge, delete branches or worktrees, or try to dispatch other tasks.",
      REPORT_INSTRUCTIONS,
    ];
    return parts.filter(Boolean).join("\n\n");
  }

  /**
   * The launch protocol. Intent is persisted before any side effect and every
   * acknowledged identifier is persisted immediately, so a crash at any point
   * leaves enough state for conservative reconciliation.
   */
  private async launch(taskId: string, relaunch: boolean): Promise<void> {
    let row = this.store.taskRow(taskId);
    if (!row || row.state !== "queued") return;
    // A relaunch reuses its worktree: refresh it before a worker owns it again.
    let syncNote: string | null = null;
    if (row.workspacePath) {
      syncNote = await this.syncAtBoundary(taskId, "launch");
      row = this.store.taskRow(taskId);
      if (!row || row.state !== "queued") return;
    }
    const adapter = this.adapterFor(row.harness);
    const attempt = row.attempts + 1;

    // 1. Persist intent.
    let run!: WorkerRun;
    this.store.tx(() => {
      this.store.transition(taskId, "starting", { from: ["queued"], patch: { attempts: attempt } });
      run = this.store.createRun({
        taskId,
        attempt,
        harness: row.harness,
        supervisorInstance: this.o.instanceId,
      });
      this.store.updateRun(run.id, {
        harnessVersion: this.versions.get(row.harness)?.version ?? null,
      });
      this.store.appendEvent(taskId, "launch.intent", { runId: run.id, attempt });
    });
    this.crashPoint("after_intent", taskId);

    try {
      // 2. Workspace (created or reused, never replaced).
      const repo = this.store.requireRepo(this.store.requireTask(taskId).repo, {
        includeRetired: true,
      });
      const ws = await this.o.workspaces.ensure(repo, taskId, row.baseRef);
      this.store.patchTask(
        taskId,
        { workspacePath: ws.path, branch: ws.branch, baseRef: ws.baseRef },
        { type: "workspace.ready", data: ws },
      );
      this.crashPoint("after_workspace", taskId);

      // 3. Session, persisted as soon as the adapter acknowledges it.
      const task = this.store.requireTask(taskId);
      const spec = this.specFor(task, run);
      const ref = await adapter.createSession(spec);
      this.crashPoint("after_session_created", taskId);
      this.persistSession(taskId, run.id, ref.sessionId);
      this.crashPoint("after_session_persisted", taskId);

      // 4. Prompt.
      await this.sendInitialPrompt(
        adapter,
        taskId,
        run.id,
        ref.sessionId,
        relaunch || attempt > 1,
        syncNote,
      );
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      await this.launchFailed(adapter, taskId, run, error);
    }
  }

  private persistSession(taskId: string, runId: string, sessionId: string): void {
    this.store.tx(() => {
      this.store.updateRun(runId, { sessionId, state: "acknowledged" });
      this.store.patchTask(
        taskId,
        { sessionId },
        { type: "session.created", data: { runId, sessionId } },
      );
    });
  }

  private async sendInitialPrompt(
    adapter: HarnessAdapter,
    taskId: string,
    runId: string,
    sessionId: string,
    relaunch: boolean,
    syncNote: string | null = null,
  ): Promise<void> {
    const task = this.store.requireTask(taskId);
    this.store.appendEvent(taskId, "prompt.intent", { runId, sessionId });
    await adapter.prompt({ sessionId }, this.buildPrompt(task, relaunch, syncNote));
    this.crashPoint("after_prompt", taskId);
    const now = this.store.now();
    this.store.tx(() => {
      this.store.updateRun(runId, { state: "prompted" });
      this.store.transition(taskId, "running", {
        from: ["starting"],
        patch: { startedAt: task.startedAt ?? now, lastActivityAt: now, error: null },
      });
    });
  }

  private async launchFailed(
    adapter: HarnessAdapter,
    taskId: string,
    run: WorkerRun,
    error: unknown,
  ): Promise<void> {
    const message = redact(error instanceof Error ? error.message : String(error));
    this.log.warn({ taskId, err: error }, "launch failed");
    const current = this.store.requireRun(run.id);
    const task = this.store.requireTask(taskId);
    const end = {
      state: "ended" as const,
      endedAt: this.store.now(),
      exitReason: `launch_failed: ${message}`,
    };

    if (error instanceof WorkspaceError) {
      this.store.updateRun(run.id, end);
      this.store.transition(taskId, "needs_attention", {
        patch: { error: message },
        attention: [
          this.attentionFor(
            task,
            "failure",
            `workspace:${run.id}`,
            `Workspace problem: ${message}`,
            "human",
            { headline: "Workspace problem", detail: message },
          ),
        ],
      });
      return;
    }

    if (error instanceof HarnessUnavailableError && !current.sessionId) {
      // Nothing reached the harness, so the launch was provably not admitted: queue it again.
      this.harnessRetryAt.set(task.harness, this.o.clock() + HARNESS_RETRY_MS);
      this.store.tx(() => {
        this.store.updateRun(run.id, { ...end, exitReason: `harness_unavailable: ${message}` });
        this.store.transition(taskId, "queued", {
          event: { type: "launch.deferred", data: { runId: run.id, reason: message } },
        });
        this.store.raiseAttention(
          {
            taskId: null,
            kind: "failure",
            dedupeKey: `harness-down:${task.harness}`,
            reason: `The ${task.harness} harness is unreachable (${message}). Queued work waits until it is back.`,
            resolvableBy: "human",
          },
          {
            notify: true,
            wake: false,
            notice: {
              headline: "Harness unreachable",
              detail: `${task.harness}: queued work waits until it is back`,
            },
          },
        );
      });
      return;
    }

    // Determine whether the harness admitted anything before the failure.
    let admitted: "no" | "yes" | "unknown" = "unknown";
    try {
      if (current.sessionId) {
        const snap = await adapter.inspect({ sessionId: current.sessionId });
        admitted = snap.prompted ? "yes" : "no";
      } else {
        const found = await adapter.findSession(this.specFor(task, run));
        admitted = found ? "unknown" : "no";
      }
    } catch {
      admitted = "unknown";
    }

    if (admitted === "yes") {
      // The prompt reached the worker despite the error: it is running.
      this.store.tx(() => {
        this.store.updateRun(run.id, { state: "prompted" });
        this.store.transition(taskId, "running", {
          patch: { startedAt: this.store.now(), lastActivityAt: this.store.now() },
        });
      });
      return;
    }
    this.store.updateRun(run.id, end);
    if (admitted === "no") {
      this.store.transition(taskId, "failed", {
        patch: { error: message },
        event: { type: "launch.not_admitted", data: { runId: run.id } },
        attention: [
          this.attentionFor(
            task,
            "failure",
            `launch:${run.id}`,
            `Launch failed before the worker started: ${message}`,
            "human",
            { headline: "Task failed to start", detail: message },
          ),
        ],
      });
    } else {
      this.store.transition(taskId, "needs_attention", {
        patch: { error: message },
        attention: [
          this.attentionFor(
            task,
            "ambiguous_launch",
            `ambiguous:${run.id}`,
            `Launch outcome is uncertain (${message}). Inspect the workspace before resuming; OCD will not retry automatically.`,
            "human",
            { detail: "Inspect the workspace before resuming" },
          ),
        ],
      });
    }
  }

  private attentionFor(
    task: Pick<Task, "id" | "harness" | "sessionId">,
    kind: Attention["kind"],
    key: string,
    reason: string,
    resolvableBy: Actor,
    notice?: Notice,
  ): { input: AttentionInput; notify: boolean; wake: boolean; notice?: Notice } {
    return {
      input: {
        taskId: task.id,
        kind,
        dedupeKey: `${kind}:${task.id}:${key}`,
        reason: truncate(redact(reason), 2000),
        harness: task.harness,
        sessionId: task.sessionId,
        resolvableBy,
      },
      notify: true,
      wake: true,
      ...(notice ? { notice } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Harness events

  private async onAdapterEvent(adapter: HarnessAdapter, event: AdapterEvent): Promise<void> {
    if (this.stopped) return;
    try {
      if (event.type === "stream") {
        this.log.info({ harness: adapter.harness, state: event.state }, "harness event stream");
        if (event.state === "connected")
          await this.reconcile("stream_reconnected", adapter.harness);
        return;
      }
      const row = this.store.taskBySession(event.sessionId);
      if (!row) return;
      await this.withTaskLock(row.id, async () => {
        switch (event.type) {
          case "activity":
            this.recordActivity(row.id);
            return;
          case "interaction":
            this.recordActivity(row.id);
            await this.onInteraction(adapter, row.id, event.interaction);
            return;
          case "interaction_resolved":
            this.onInteractionResolved(row.id, event.interactionId);
            return;
          case "todos":
            this.recordActivity(row.id);
            this.recordTodos(row.id, event.todos);
            return;
          case "status":
            this.recordActivity(row.id);
            await this.applySnapshot(
              adapter,
              row.id,
              await adapter.inspect({ sessionId: event.sessionId }),
            );
            return;
        }
      });
    } catch (error) {
      if (!this.handleCrash(error))
        this.log.error({ err: error, event }, "failed to handle harness event");
    }
  }

  private recordActivity(taskId: string): void {
    const now = this.o.clock();
    if (now - (this.lastActivityWrite.get(taskId) ?? 0) < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite.set(taskId, now);
    this.store.touchActivity(taskId, iso(now));
  }

  private recordTodos(taskId: string, items: TodoItem[]): void {
    this.todos.delete(taskId);
    this.todos.set(taskId, { items, at: iso(this.o.clock()) });
    for (const oldest of this.todos.keys()) {
      if (this.todos.size <= TODO_TASKS_MAX) break;
      this.todos.delete(oldest);
    }
  }

  /** A task's latest checklist and recent events, for the sidebar. Read-only. */
  taskProgress(taskId: string): TaskProgress {
    const task = this.store.requireTask(taskId);
    const todos = this.todos.get(taskId);
    return {
      taskId,
      todosSupported: this.adapters.get(task.harness)?.capabilities.todos ?? false,
      todos: todos?.items ?? null,
      todosUpdatedAt: todos?.at ?? null,
      events: this.store.events(taskId, PROGRESS_EVENTS),
    };
  }

  private async onInteraction(
    adapter: HarnessAdapter,
    taskId: string,
    interaction: {
      id: string;
      kind: "permission" | "question";
      summary: string;
      operation: unknown;
    },
  ): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!LIVE_STATES.has(task.state)) return;
    const run = this.store.latestRun(taskId);
    const binding = {
      harness: task.harness,
      sessionId: task.sessionId,
      runId: run?.id ?? null,
      requestRef: interaction.id,
      operation: interaction.operation,
    };
    const baseKey = `${interaction.kind}:${taskId}:${interaction.id}`;
    let dedupeKey = baseKey;
    let askPrefix = interaction.kind === "permission" ? "Permission requested" : "Question";

    if (interaction.kind === "permission" && task.profile.permissionPolicy === "deny") {
      // The profile does not forward permissions: deny and surface the block.
      await adapter.reply({ sessionId: task.sessionId! }, interaction.id, {
        type: "deny",
        message: "Denied by OCD profile policy. Report what you needed in your final ocd-report.",
      });
      this.store.raiseAttention(
        {
          taskId,
          kind: "permission",
          dedupeKey,
          status: "rejected",
          reason: truncate(
            redact(`Permission denied by profile policy: ${interaction.summary}`),
            2000,
          ),
          resolvableBy: "human",
          ...binding,
        },
        {
          notify: true,
          wake: true,
          notice: {
            headline: "Permission denied",
            detail: `Profile policy: ${interaction.summary}`,
          },
        },
      );
      return;
    }

    if (interaction.kind === "permission" && task.profile.permissionPolicy === "yolo") {
      // The harness was told to skip permission checks; anything it still asks

      // (e.g. protected config files) is approved without an inbox record.

      await adapter.reply({ sessionId: task.sessionId! }, interaction.id, { type: "approve" });

      this.store.appendEvent(taskId, "permission.yolo_approved", {
        summary: truncate(redact(interaction.summary), 300),
      });

      return;
    }

    if (interaction.kind === "permission" && task.profile.permissionPolicy === "allow") {
      // Explicit opt-in: approve this one request and keep an audit record. The
      // record is written first so a repeated event never approves twice.
      const { attention, created } = this.store.raiseAttention(
        {
          taskId,
          kind: "permission",
          dedupeKey,
          reason: truncate(
            redact(`Permission auto-approved by profile policy: ${interaction.summary}`),
            2000,
          ),
          resolvableBy: "human",
          ...binding,
        },
        { notify: false, wake: false },
      );
      if (!created) return;
      try {
        await adapter.reply({ sessionId: task.sessionId! }, interaction.id, { type: "approve" });
        this.store.settleAttention(attention.id, {
          status: "resolved",
          response: { type: "approve" },
        });
        return;
      } catch (error) {
        // The worker is still waiting: do not leave a record saying it was approved.
        // Settle it as expired and ask the human through the normal path instead.
        const message = truncate(redact(String(error)), 300);
        this.store.tx(() => {
          this.store.settleAttention(attention.id, { status: "expired" });
          this.store.appendEvent(taskId, "permission.auto_approve_failed", {
            id: interaction.id,
            error: message,
          });
        });
        dedupeKey = `${baseKey}:reply_failed`;
        askPrefix = `Permission requested (auto-approve failed: ${message})`;
      }
    }

    // Workflow questions may be answered by the manager; permissions only by a human.
    const resolvableBy: Actor = interaction.kind === "permission" ? "human" : "manager";
    const attention = {
      input: {
        taskId,
        kind: interaction.kind,
        dedupeKey,
        reason: truncate(redact(`${askPrefix}: ${interaction.summary}`), 2000),
        resolvableBy,
        expiresAt: iso(this.o.clock() + this.o.config.attentionExpiryMinutes * 60_000),
        ...binding,
      },
      notify: true,
      wake: true,
      // The headline comes from the kind; the click only opens the manager session.
      notice: { detail: interaction.summary },
    };
    if (task.state === "running") {
      this.store.transition(taskId, "blocked", {
        event: { type: "interaction.pending", data: { id: interaction.id } },
        attention: [attention],
      });
    } else {
      this.store.raiseAttention(attention.input, attention);
    }
  }

  private onInteractionResolved(taskId: string, interactionId: string): void {
    for (const a of this.store.listAttention({
      taskId,
      status: "open",
      kinds: [...INTERACTION_KINDS],
    })) {
      if (a.requestRef === interactionId) {
        this.store.settleAttention(a.id, {
          status: "resolved",
          response: { type: "acknowledge", note: "Resolved in the harness" },
        });
      }
    }
    this.unblockIfClear(taskId);
  }

  private unblockIfClear(taskId: string): void {
    const task = this.store.requireTask(taskId);
    if (task.state !== "blocked") return;
    const open = this.store.listAttention({
      taskId,
      status: "open",
      kinds: [...INTERACTION_KINDS],
    });
    if (open.length === 0) this.store.transition(taskId, "running", { from: ["blocked"] });
  }

  /** Applies a harness snapshot to a live task. */
  private async applySnapshot(
    adapter: HarnessAdapter,
    taskId: string,
    snap: SessionSnapshot,
  ): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!LIVE_STATES.has(task.state) || task.sessionId !== snap.sessionId) return;
    switch (snap.status) {
      case "busy":
        if (task.state === "blocked" && snap.pending.length === 0) this.unblockIfClear(taskId);
        return;
      case "waiting":
        for (const interaction of snap.pending)
          await this.onInteraction(adapter, taskId, interaction);
        this.expireStaleInteractions(task, snap);
        return;
      case "idle":
        this.expireStaleInteractions(task, snap);
        await this.finishRun(task, snap);
        return;
      case "error":
        if (snap.quotaLimited) {
          // A usage limit is a wait, not a failure and never a success.
          if (task.state !== "blocked") {
            this.store.transition(taskId, "blocked", {
              event: { type: "quota.limited", data: { error: snap.error } },
              attention: [
                this.attentionFor(
                  task,
                  "decision",
                  `quota:${task.attempts}`,
                  `Harness usage limit reached: ${snap.error ?? "unknown"}. Resume after the limit resets.`,
                  "human",
                  {
                    headline: "Usage limit reached",
                    detail: snap.error ?? "Resume after the limit resets",
                  },
                ),
              ],
            });
          }
          return;
        }
        this.endRun(taskId, `error: ${snap.error ?? "unknown"}`);
        this.store.transition(taskId, "failed", {
          patch: { error: truncate(redact(snap.error ?? "Harness reported an error"), 2000) },
          attention: [
            this.attentionFor(
              task,
              "failure",
              `error:${task.attempts}`,
              `Worker failed: ${snap.error ?? "unknown error"}. The workspace is preserved.`,
              "human",
              { headline: "Task failed", detail: snap.error ?? "Unknown error" },
            ),
          ],
        });
        return;
      case "missing":
        this.endRun(taskId, "session_missing");
        this.store.transition(taskId, "interrupted", {
          event: { type: "session.missing", data: { sessionId: task.sessionId } },
          attention: [
            this.attentionFor(
              task,
              "failure",
              `missing:${task.sessionId}`,
              "The worker session is gone. The workspace is preserved; resume explicitly if needed.",
              "human",
              { headline: "Worker session lost", detail: "Workspace preserved; resume if needed" },
            ),
          ],
        });
        return;
    }
  }

  /** Interactive requests the harness no longer has, or that passed their expiry, are never replayed. */
  private expireStaleInteractions(task: Task, snap: SessionSnapshot): void {
    const live = new Set(snap.pending.map((p) => p.id));
    for (const a of this.store.listAttention({
      taskId: task.id,
      status: "open",
      kinds: [...INTERACTION_KINDS],
    })) {
      if (a.sessionId !== snap.sessionId || !a.requestRef || !live.has(a.requestRef)) {
        this.store.settleAttention(a.id, { status: "expired" });
        this.store.appendEvent(task.id, "attention.expired", { id: a.id });
      }
    }
  }

  private endRun(taskId: string, reason: string): void {
    const run = this.store.latestRun(taskId);
    if (run && run.state !== "ended")
      this.store.updateRun(run.id, {
        state: "ended",
        endedAt: this.store.now(),
        exitReason: reason,
      });
  }

  /**
   * An idle worker is not proof of completion. Collect the structured report and
   * independent verification; a valid report makes the task ready for review.
   */
  private async finishRun(task: Task, snap: SessionSnapshot): Promise<void> {
    if (
      task.state === "blocked" &&
      this.store.listAttention({ taskId: task.id, status: "open", kinds: [...INTERACTION_KINDS] })
        .length > 0
    ) {
      return;
    }
    const text = snap.lastAssistantText ?? "";
    const parsed = parseWorkerReport(text);
    let verification: TaskResult["verification"] = null;
    let verifyError: string | null = null;
    if (task.workspacePath && task.baseRef) {
      try {
        verification = await this.o.workspaces.verify({
          path: task.workspacePath,
          baseRef: task.baseRef,
        });
      } catch (error) {
        verifyError = truncate(redact(String(error)), 2000);
      }
    }
    const result: TaskResult = {
      reported: parsed.ok ? sanitizeReport(parsed.report) : null,
      reportError: parsed.ok ? null : parsed.error,
      verification,
      finalMessageExcerpt: text ? truncate(redact(text), 2000) : null,
    };
    this.endRun(task.id, "idle");
    const fresh = this.store.requireTask(task.id);
    if (!LIVE_STATES.has(fresh.state)) return;
    if (parsed.ok) {
      const summary = `Ready for review: ${task.title}. Worker summary: "${truncate(parsed.report.summary, 300)}". Verified changed files: ${verification?.changedFiles.length ?? "unknown"}.`;
      this.store.transition(task.id, "ready_for_review", {
        patch: { result, finishedAt: this.store.now() },
        attention: [
          this.attentionFor(fresh, "review", `review:${fresh.attempts}`, summary, "human", {
            // Verified facts only; the worker's own summary stays in the inbox.
            detail: changedFilesText(verification?.changedFiles.length) ?? "",
          }),
        ],
      });
    } else {
      this.store.transition(task.id, "needs_attention", {
        patch: { result, error: verifyError },
        attention: [
          this.attentionFor(
            fresh,
            "failure",
            `noreport:${fresh.attempts}`,
            `Worker went idle without a valid report (${result.reportError}). Not treated as success.`,
            "manager",
            { headline: "Report missing", detail: "Worker stopped without a valid report" },
          ),
        ],
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Reconciliation

  private async periodicReconcile(): Promise<void> {
    const now = this.o.clock();
    const gap = now - this.lastReconcileTick;
    this.lastReconcileTick = now;
    if (gap > this.o.config.reconcileIntervalMs * 3) {
      // Timers did not fire: the machine likely slept. Sleep time is not inactivity.
      this.activityBaseline = now;
      this.log.info({ gapMs: gap }, "detected wake from sleep");
      await this.reconcile("wake");
      return;
    }
    await this.reconcile("periodic");
  }

  /**
   * Compares persisted state with what the harnesses actually report. Runs on
   * startup, periodically, after stream reconnection, and after waking.
   */
  async reconcile(reason: string, harness?: HarnessName): Promise<void> {
    const rows = this.store
      .rowsInStates([...LIVE_STATES])
      .filter((r) => !harness || r.harness === harness);
    for (const row of rows) {
      try {
        await this.withTaskLock(row.id, () => this.reconcileTask(row.id, reason));
      } catch (error) {
        if (this.handleCrash(error)) return;
        this.log.error({ err: error, taskId: row.id }, "reconcile failed");
      }
    }
    if (reason !== "startup") this.expireOverdueAttention();
    if (reason === "startup" || reason === "wake") void this.o.outbox.flush();
  }

  private async reconcileTask(taskId: string, reason: string): Promise<void> {
    const task = this.store.requireTask(taskId);
    if (!LIVE_STATES.has(task.state)) return;
    const adapter = this.adapters.get(task.harness);
    const run = this.store.latestRun(taskId);
    if (!adapter || !run) {
      this.store.transition(taskId, "needs_attention", {
        attention: [
          this.attentionFor(
            task,
            "failure",
            `noadapter:${run?.id ?? "none"}`,
            `Cannot reconcile: harness ${task.harness} is not available.`,
            "human",
            { headline: "Harness unavailable", detail: `Harness ${task.harness} is not available` },
          ),
        ],
      });
      return;
    }

    if (task.state === "starting") {
      await this.reconcileStarting(adapter, task, run);
      return;
    }

    if (!task.sessionId) return;
    let snap: SessionSnapshot;
    try {
      snap = await adapter.inspect({ sessionId: task.sessionId });
    } catch (error) {
      this.log.warn({ err: error, taskId }, "inspect failed during reconcile");
      return;
    }
    if (snap.status === "missing" && !adapter.sessionsSurviveSupervisor && reason === "startup") {
      this.endRun(taskId, "lost_with_supervisor");
      this.store.transition(taskId, "interrupted", {
        event: { type: "worker.lost", data: { sessionId: task.sessionId, reason } },
        attention: [
          this.attentionFor(
            task,
            "failure",
            `lost:${run.id}`,
            `The worker did not survive a supervisor restart (session ${task.sessionId}). The workspace is preserved; resume explicitly.`,
            "human",
            {
              headline: "Task interrupted",
              detail: "Worker lost in an OCD restart; resume explicitly",
            },
          ),
        ],
      });
      return;
    }
    await this.applySnapshot(adapter, taskId, snap);
    if (snap.status === "busy") this.checkStall(this.store.requireTask(taskId));
  }

  /** A task left in `starting` by a crash: decide from evidence, never by guessing. */
  private async reconcileStarting(
    adapter: HarnessAdapter,
    task: Task,
    run: WorkerRun,
  ): Promise<void> {
    if (run.state === "launching") {
      const found = task.workspacePath ? await adapter.findSession(this.specFor(task, run)) : null;
      if (!found) {
        // No session exists, so no worker ever ran: safe to return to the queue.
        this.store.tx(() => {
          this.store.updateRun(run.id, {
            state: "ended",
            endedAt: this.store.now(),
            exitReason: "not_admitted",
          });
          this.store.transition(task.id, "queued", {
            event: { type: "launch.not_admitted", data: { runId: run.id } },
          });
        });
        void this.tick();
        return;
      }
      this.persistSession(task.id, run.id, found.sessionId);
      run = this.store.requireRun(run.id);
    }
    const sessionId = run.sessionId!;
    let snap: SessionSnapshot;
    try {
      snap = await adapter.inspect({ sessionId });
    } catch (error) {
      this.log.warn({ err: error, taskId: task.id }, "inspect failed for starting task");
      return;
    }
    if (snap.status !== "missing" && !snap.prompted) {
      // The session exists but never received work: finishing the launch cannot duplicate edits.
      await this.sendInitialPrompt(adapter, task.id, run.id, sessionId, task.attempts > 1);
      return;
    }
    if (snap.status !== "missing") {
      this.store.tx(() => {
        this.store.updateRun(run.id, { state: "prompted" });
        this.store.transition(task.id, "running", {
          patch: { startedAt: this.store.now(), lastActivityAt: this.store.now() },
        });
      });
      await this.applySnapshot(adapter, task.id, snap);
      return;
    }
    // The session is gone and we cannot tell whether it did any work.
    this.endRun(task.id, "ambiguous_launch");
    this.store.transition(task.id, "needs_attention", {
      event: { type: "launch.ambiguous", data: { runId: run.id, sessionId } },
      attention: [
        this.attentionFor(
          { ...task, sessionId },
          "ambiguous_launch",
          `ambiguous:${run.id}`,
          `A crash interrupted the launch of ${task.id} after its prompt may have been sent, and session ${sessionId} is gone. Inspect ${task.workspacePath} before resuming; OCD will not retry automatically.`,
          "human",
          { detail: "Inspect the workspace before resuming" },
        ),
      ],
    });
  }

  private checkStall(task: Task): void {
    if (task.state !== "running") return;
    const last = Math.max(
      task.lastActivityAt ? Date.parse(task.lastActivityAt) : 0,
      this.activityBaseline,
    );
    const idleMs = this.o.clock() - last;
    if (idleMs < this.o.config.stallAfterMinutes * 60_000) return;
    // One alert per window; the dedupe key rate-limits repeats.
    const window = Math.floor(this.o.clock() / (this.o.config.stallRealertMinutes * 60_000));
    this.store.raiseAttention(
      {
        taskId: task.id,
        kind: "stall",
        dedupeKey: `stall:${task.id}:${window}`,
        reason: `No worker activity for ${Math.round(idleMs / 60_000)} minutes while busy. Inspect it; OCD does not kill inactive workers.`,
        harness: task.harness,
        sessionId: task.sessionId,
        resolvableBy: "manager",
      },
      {
        notify: true,
        wake: false,
        notice: { detail: `No worker activity for ${Math.round(idleMs / 60_000)} min` },
      },
    );
  }

  private expireOverdueAttention(): void {
    const now = this.store.now();
    for (const a of this.store.listAttention({
      status: "open",
      kinds: [...INTERACTION_KINDS, "land"],
      limit: 200,
    })) {
      if (!a.expiresAt || a.expiresAt > now || !a.taskId) continue;
      this.withTaskLock(a.taskId, () => this.expireInteraction(a.id)).catch((error: unknown) => {
        this.log.warn({ err: error, attentionId: a.id }, "expiring an overdue request failed");
      });
    }
  }

  /** Denies an expired request in the harness so the worker is not left waiting; never replays it. */
  private async expireInteraction(attentionId: string): Promise<void> {
    const a = this.store.requireAttention(attentionId);
    if (a.status !== "open") return;
    const task = a.taskId ? this.store.getTask(a.taskId) : null;
    const adapter = task ? this.adapters.get(task.harness) : undefined;
    if (adapter && a.sessionId && a.requestRef) {
      await adapter
        .reply({ sessionId: a.sessionId }, a.requestRef, {
          type: "deny",
          message: "Request expired without a human decision.",
        })
        .catch(() => undefined);
    }
    this.store.tx(() => {
      this.store.settleAttention(a.id, { status: "expired" });
      if (a.taskId) this.store.appendEvent(a.taskId, "attention.expired", { id: a.id });
      const copy = notification({
        headline: a.kind === "land" ? "Push confirmation expired" : "Request expired",
        task,
        detail:
          a.kind === "land"
            ? "The push was not confirmed in time and will not happen; ask again to land it"
            : `${a.kind === "question" ? "Question" : "Permission request"} went unanswered and was denied`,
      });
      this.store.enqueue([
        {
          kind: "notify",
          dedupeKey: `notify:expired:${a.id}`,
          payload: { ...copy, ...(a.taskId ? { taskId: a.taskId } : {}) },
        },
      ]);
    });
    if (a.taskId) this.unblockIfClear(a.taskId);
  }

  // ---------------------------------------------------------------------------
  // Task controls

  async cancel(taskId: string, reason: string | undefined): Promise<Task> {
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (task.state === "completed" || task.state === "cancelled")
        throw conflict("task_finished", `Task is ${task.state}`);
      const adapter = this.adapters.get(task.harness);
      if (task.sessionId && adapter && LIVE_STATES.has(task.state)) {
        requireCapability(adapter, "interrupt");
        await adapter.interrupt({ sessionId: task.sessionId });
      }
      this.endRun(taskId, "cancelled");
      for (const a of this.store.listAttention({ taskId, status: "open" }))
        this.store.settleAttention(a.id, { status: "expired" });
      // Cancelling never deletes the workspace.
      const cancelled = this.store.transition(taskId, "cancelled", {
        patch: { finishedAt: this.store.now() },
        event: {
          type: "task.cancelled",
          data: { reason: reason ?? null, workspacePreserved: task.workspacePath },
        },
      });
      this.releaseWorker(cancelled);
      return cancelled;
    });
  }

  /**
   * Read-only view of a worker's recent messages and tool activity. Takes no
   * task lock and writes nothing: it never starts, resumes, prompts or
   * releases a worker, so it is safe in every state, including manual mode.
   */
  async peek(taskId: string, input: z.output<typeof PeekTaskInput>): Promise<TaskTranscript> {
    const task = this.store.requireTask(taskId);
    const result: TaskTranscript = {
      taskId: task.id,
      harness: task.harness,
      sessionId: task.sessionId,
      taskState: task.state,
      available: false,
      source: null,
      notes: [],
      entries: [],
      before: null,
      truncated: false,
      reasoningSummaries: input.reasoningSummaries ? "unsupported" : "excluded",
      untrusted: true,
      notice: TRANSCRIPT_NOTICE,
      generatedAt: this.store.now(),
    };
    const unavailable = (note: string) => ({ ...result, notes: [...result.notes, note] });
    if (!task.sessionId)
      return unavailable(`The task has no worker session yet (it is ${task.state}).`);
    const sessionId = task.sessionId;
    // Cursors are bound to this task's session: one from another task (or an
    // earlier session of this task) is refused rather than read elsewhere.
    let before: string | null = null;
    if (input.before !== undefined) {
      const cursor = decodeCursor(input.before);
      if (!cursor || cursor.t !== task.id || cursor.s !== sessionId)
        throw badRequest("invalid_cursor", "The cursor does not belong to this task's session");
      before = cursor.b;
    }
    const adapter = this.adapters.get(task.harness);
    if (!adapter?.transcript || !adapter.capabilities.transcript)
      return unavailable(`The ${task.harness} adapter cannot read worker transcripts.`);
    if (task.state === "manual")
      result.notes.push(
        "The human is driving this session directly (manual mode); OCD only reads it.",
      );
    const timeoutMs = this.o.hooks?.peekTimeoutMs ?? PEEK_TIMEOUT_MS;
    const read = async (limit: number): Promise<TranscriptPage | null> => {
      const abort = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          adapter.transcript!(
            { sessionId },
            { limit, before, reasoningSummaries: input.reasoningSummaries, signal: abort.signal },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new Error(`timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    // Defense in depth: re-apply redaction and bounds whatever the adapter did.
    const bounded = (page: TranscriptPage) => {
      let entries = page.entries.slice(-input.limit).map(sanitizeEntry);
      let size = entries.reduce((sum, e) => sum + entrySize(e), 0);
      while (entries.length > 1 && size > TRANSCRIPT_LIMITS.responseChars) {
        size -= entrySize(entries[0]!);
        entries = entries.slice(1);
      }
      return entries;
    };
    let page: TranscriptPage | null;
    let entries: TranscriptEntry[] = [];
    try {
      page = await read(input.limit);
      if (page) {
        entries = bounded(page);
        if (entries.length < Math.min(input.limit, page.entries.length)) {
          // Too large for one response: read fewer, so the adapter's cursor
          // continues exactly where this page ends.
          result.notes.push(
            `Only the newest ${entries.length} entries fit in one response (${TRANSCRIPT_LIMITS.responseChars} characters); page back for older ones.`,
          );
          page = await read(entries.length);
          entries = page ? bounded(page) : [];
        }
      }
    } catch (error) {
      if (error instanceof InvalidCursorError) throw badRequest("invalid_cursor", error.message);
      return unavailable(
        `Reading the ${task.harness} transcript failed: ${truncate(redact((error as Error).message ?? String(error)), 300)}`,
      );
    }
    if (!page) {
      return unavailable(
        adapter.sessionsSurviveSupervisor
          ? `The ${task.harness} session ${sessionId} no longer exists in the harness.`
          : `OCD has no record of this ${task.harness} session's activity: it keeps what it observes from Claude Code / Codex workers in memory only, so nothing is available after a supervisor restart, for a session OCD never ran in this process, or once newer sessions have pushed it out. OCD never resumes a session just to read it.`,
      );
    }
    const exact = entries.length === Math.min(input.limit, page.entries.length);
    return {
      ...result,
      available: true,
      source: page.source,
      notes: [...result.notes, ...page.notes],
      entries,
      before:
        page.before !== null && exact
          ? encodeCursor({ t: task.id, s: sessionId, b: page.before })
          : null,
      truncated: page.truncated || !exact,
      reasoningSummaries: page.reasoningSummaries,
    };
  }

  async sendToWorker(taskId: string, instructions: string): Promise<Task> {
    return this.withTaskLock(taskId, () => this.sendToWorkerLocked(taskId, instructions));
  }

  /** sendToWorker() inside the task lock. */
  private async sendToWorkerLocked(taskId: string, instructions: string): Promise<Task> {
    {
      const task = this.store.requireTask(taskId);
      if (!task.sessionId) throw conflict("no_session", "Task has no worker session yet");
      if (!["running", "blocked", "ready_for_review"].includes(task.state)) {
        throw conflict("not_steerable", `Cannot send instructions to a ${task.state} task`);
      }
      const adapter = this.adapterFor(task.harness);
      requireCapability(adapter, "steer");
      // A follow-up re-opens the review (the worker re-reports and OCD re-verifies),
      // so it is the boundary where a stale reviewed branch may be refreshed.
      const syncNote =
        task.state === "ready_for_review" ? await this.syncAtBoundary(taskId, "follow_up") : null;
      const text = [syncNote, instructions, REPORT_INSTRUCTIONS].filter(Boolean).join("\n\n");
      try {
        await adapter.prompt({ sessionId: task.sessionId }, text);
      } catch (error) {
        if (syncNote) await this.followUpNotSent(taskId, error);
        throw error;
      }
      if (this.store.requireTask(taskId).state === "ready_for_review") {
        const run = this.store.latestRun(taskId);
        if (run)
          this.store.updateRun(run.id, { state: "prompted", endedAt: null, exitReason: null });
        for (const a of this.store.listAttention({ taskId, status: "open", kinds: ["review"] })) {
          this.store.settleAttention(a.id, {
            status: "resolved",
            response: { type: "acknowledge", note: "Follow-up sent" },
          });
        }
        return this.store.transition(taskId, "running", {
          patch: { finishedAt: null, lastActivityAt: this.store.now() },
          event: { type: "worker.steered", data: { chars: instructions.length } },
        });
      }
      this.store.appendEvent(taskId, "worker.steered", { chars: instructions.length });
      return this.store.requireTask(taskId);
    }
  }

  /**
   * The branch was refreshed for a follow-up that never reached the worker, so
   * the task is still under review: re-verify so the review shows the branch as
   * it is now, and say that the worker's report predates the merge.
   */
  private async followUpNotSent(taskId: string, error: unknown): Promise<void> {
    const task = this.store.requireTask(taskId);
    let verification: TaskResult["verification"] = task.result?.verification ?? null;
    if (task.workspacePath && task.baseRef) {
      verification = await this.o.workspaces
        .verify({ path: task.workspacePath, baseRef: task.baseRef })
        .catch(() => verification);
    }
    const sync = task.branchSync;
    this.store.patchTask(
      taskId,
      {
        ...(task.result ? { result: { ...task.result, verification } } : {}),
        ...(sync
          ? {
              branchSync: {
                ...sync,
                reason: `${sync.reason} The follow-up was not delivered, so the worker's report predates this merge; OCD re-verified the branch.`,
              },
            }
          : {}),
      },
      {
        type: "branch_sync.follow_up_not_sent",
        data: { error: truncate(redact(String(error)), 500) },
      },
    );
  }

  /**
   * Marks a reviewed task completed. The human (CLI) or the manager (after the
   * human approves in conversation) may accept; nothing is merged either way.
   */
  async accept(taskId: string, actor: Actor): Promise<Task> {
    const done = await this.withTaskLock(taskId, async () => this.acceptLocked(taskId, actor));
    this.releaseWorker(done);
    void this.tick();
    return done;
  }

  /** accept() inside the task lock. */
  private acceptLocked(taskId: string, actor: Actor): Task {
    const task = this.store.requireTask(taskId);
    if (task.state !== "ready_for_review")
      throw conflict("not_reviewable", `Task is ${task.state}, not ready_for_review`);
    return this.store.tx(() => {
      for (const a of this.store.listAttention({ taskId, status: "open", kinds: ["review"] })) {
        this.store.settleAttention(a.id, {
          status: "resolved",
          response: { type: "approve" },
          resolvedBy: actor,
        });
      }
      // Accepted work is never refreshed, so an open conflict report is moot.
      this.store.settleOpenAttention(branchSyncAttentionKey(taskId), "expired");
      return this.store.transition(taskId, "completed", {
        from: ["ready_for_review"],
        patch: { finishedAt: this.store.now() },
        event: { type: "task.accepted", data: { actor } },
      });
    });
  }

  /**
   * Manual mode: the human takes over the worker's session and drives it
   * directly. OCD stops driving it (interrupting a running turn, stopping a
   * process-owned worker) and ignores it until it is handed back; the manager
   * is told to leave it alone.
   */
  async takeOver(taskId: string, actor: Actor): Promise<TakeOverResult> {
    if (actor !== "human")
      throw forbidden("human_only", "Only a human can take over a worker's session");
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (task.state !== "manual" && !TAKEOVER_STATES.has(task.state))
        throw conflict("not_takeoverable", `A ${task.state} task cannot be taken over`);
      if (!task.sessionId || !task.workspacePath)
        throw conflict("no_session", "The task has no worker session to take over");
      const adapter = this.adapterFor(task.harness);
      if (!adapter.interactiveCommand)
        throw conflict("not_supported", `${task.harness} sessions cannot be opened interactively`);
      const ref = { sessionId: task.sessionId };
      // Already manual: just say again how to open the session.
      const env = workerOcdEnv(join(this.o.sandboxRoot, task.id));
      const opened = {
        command: adapter.interactiveCommand(ref),
        cwd: task.workspacePath,
        env,
        tmux: this.o.config.tmux.enabled,
      };
      if (task.state === "manual") return { task, ...opened };
      // Leave the live states first: an interrupted worker reports idle, which
      // must not be read as a finished turn.
      const manual = this.store.tx(() => {
        for (const a of this.store.listAttention({ taskId, status: "open" }))
          this.store.settleAttention(a.id, { status: "expired" });
        this.endRun(taskId, "taken_over");
        return this.store.transition(taskId, "manual", {
          patch: { lastActivityAt: this.store.now() },
          event: { type: "task.taken_over", data: { actor, from: task.state } },
          outbox: [
            this.wake(
              task,
              `manual:${this.store.now()}`,
              `[manual] Task ${task.id} ("${task.title}", repo ${task.repo}): the human took over the ${task.harness} session and is driving it directly. Do not send it work, cancel, accept or resume it until they hand it back.`,
            ),
          ],
        });
      });
      if (LIVE_STATES.has(task.state)) {
        await adapter
          .interrupt(ref)
          .catch((error) =>
            this.log.warn({ err: error, taskId }, "interrupting the worker for a takeover failed"),
          );
      }
      // A process-owned worker must be gone before the human resumes its session.
      await adapter.release?.(ref);
      return { task: manual, ...opened };
    });
  }

  /**
   * Ends manual mode. "continue" resumes the worker headless on the same
   * session with the human's note; "review" moves the task to review. Either
   * way the manager is told and may act on the task again.
   */
  async giveBack(
    taskId: string,
    mode: "continue" | "review",
    note: string | undefined,
    actor: Actor,
  ): Promise<Task> {
    if (actor !== "human") throw forbidden("human_only", "Only a human can hand a task back");
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (task.state !== "manual")
        throw conflict("not_manual", `Task is ${task.state}, not in manual mode`);
      const adapter = this.adapterFor(task.harness);
      if (!task.sessionId) throw conflict("no_session", "The task has no worker session");
      const ref = { sessionId: task.sessionId };
      const open = await adapter.sessionInUse?.(ref);
      if (open)
        throw conflict(
          "session_in_use",
          `The session is still open in another process (pid ${open.pid}: ${open.command}); quit it first`,
        );
      const noteText = note?.trim() ? ` Their note: "${truncate(redact(note.trim()), 2000)}"` : "";
      const header = `[handed back] Task ${task.id} ("${task.title}", repo ${task.repo})`;
      if (mode === "review") {
        // The human changed the worktree by hand: show the review what is there now.
        let result = task.result;
        if (result && task.workspacePath && task.baseRef) {
          const previous = result.verification;
          const verification = await this.o.workspaces
            .verify({ path: task.workspacePath, baseRef: task.baseRef })
            .catch(() => previous);
          result = { ...result, verification };
        }
        return this.store.transition(taskId, "ready_for_review", {
          from: ["manual"],
          patch: { finishedAt: this.store.now(), ...(result ? { result } : {}) },
          event: { type: "task.given_back", data: { mode, note: note ?? null } },
          attention: [
            {
              ...this.attentionFor(
                task,
                "review",
                `manual:${this.store.now()}`,
                `${header}: the human finished it by hand and it is ready for review.${noteText}`,
                "human",
              ),
              // The human just handed it back; only the manager needs telling.
              notify: false,
            },
          ],
        });
      }
      requireCapability(adapter, "resume");
      let snap = await adapter.inspect(ref);
      if (snap.status === "missing" && adapter.revive) {
        const run = this.store.latestRun(taskId);
        if (run) {
          try {
            await adapter.revive(ref, this.specFor(task, run));
          } catch (error) {
            throw conflict(
              "session_missing",
              `The session cannot be resumed (${(error as Error).message})`,
            );
          }
        }
        snap = await adapter.inspect(ref);
      }
      if (snap.status === "missing")
        throw conflict("session_missing", "The session no longer exists");
      // A turn the human left running (OpenCode) carries on; otherwise prompt.
      const needsPrompt = snap.status === "idle" || snap.status === "error";
      if (needsPrompt) {
        // Nothing drives the session until this prompt: refresh the branch first.
        const syncNote = await this.syncAtBoundary(taskId, "hand_back");
        await adapter.prompt(
          ref,
          `The human drove this session directly for a while and has handed the task back to you.${noteText}\n\n${syncNote ? `${syncNote}\n\n` : ""}Check the current state of the worktree, continue the task, and finish with the report.\n\n${REPORT_INSTRUCTIONS}`,
        );
      }
      const run = this.store.latestRun(taskId);
      this.store.tx(() => {
        if (run)
          this.store.updateRun(run.id, { state: "prompted", endedAt: null, exitReason: null });
        this.store.transition(taskId, "running", {
          from: ["manual"],
          patch: { lastActivityAt: this.store.now(), finishedAt: null, error: null },
          event: { type: "task.given_back", data: { mode, note: note ?? null } },
          outbox: [
            this.wake(
              task,
              `given-back:${this.store.now()}`,
              `${header}: the human handed it back and the worker continues.${noteText}`,
            ),
          ],
        });
      });
      if (!needsPrompt) await this.applySnapshot(adapter, taskId, snap);
      return this.store.requireTask(taskId);
    });
  }

  private wake(task: Pick<Task, "id">, key: string, text: string) {
    return {
      kind: "manager_wake" as const,
      dedupeKey: `wake:${task.id}:${key}`,
      payload: { text: truncate(redact(text), 4000), taskId: task.id },
    };
  }

  /** Explicit, human-initiated recovery for interrupted, failed, or ambiguous tasks. */
  async resume(taskId: string, mode: "reattach" | "relaunch", actor: Actor): Promise<Task> {
    if (actor !== "human")
      throw forbidden("human_only", "Resuming an uncertain run requires a human");
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (!["interrupted", "failed", "needs_attention", "blocked"].includes(task.state)) {
        throw conflict("not_resumable", `Task is ${task.state}`);
      }
      const adapter = this.adapterFor(task.harness);
      // Open requests are settled only once the resume is known to go ahead.
      const settleOpen = () => {
        for (const a of this.store.listAttention({
          taskId,
          status: "open",
          kinds: ["failure", "ambiguous_launch", "stall", "decision"],
        })) {
          this.store.settleAttention(a.id, {
            status: "resolved",
            response: { type: "acknowledge", note: `resume:${mode}` },
            resolvedBy: "human",
          });
        }
      };
      if (mode === "relaunch") {
        if (task.state === "blocked")
          throw conflict(
            "not_resumable",
            "Cancel or reattach a blocked task instead of relaunching it",
          );
        this.store.tx(() => {
          settleOpen();
          this.store.transition(taskId, "queued", {
            event: { type: "task.resumed", data: { mode } },
          });
        });
        return this.queueAndTick(taskId);
      }
      requireCapability(adapter, "resume");
      if (!task.sessionId)
        throw conflict("no_session", "No recorded session to reattach; use relaunch");
      let snap = await adapter.inspect({ sessionId: task.sessionId });
      if (snap.status === "missing" && adapter.revive) {
        // A process-owned worker died with the supervisor; continue its session from disk.
        const run = this.store.latestRun(taskId);
        if (run) {
          try {
            await adapter.revive({ sessionId: task.sessionId }, this.specFor(task, run));
          } catch (error) {
            throw conflict(
              "session_missing",
              `The recorded session cannot be resumed (${(error as Error).message}); use relaunch`,
            );
          }
        }
        snap = await adapter.inspect({ sessionId: task.sessionId });
      }
      if (snap.status === "missing")
        throw conflict("session_missing", "The recorded session no longer exists; use relaunch");
      const needsPrompt = snap.status === "idle" || snap.status === "error";
      if (needsPrompt) {
        await adapter.prompt(
          { sessionId: task.sessionId },
          `Continue the task from where you stopped.\n\n${REPORT_INSTRUCTIONS}`,
        );
      }
      const run = this.store.latestRun(taskId);
      this.store.tx(() => {
        settleOpen();
        if (run)
          this.store.updateRun(run.id, { state: "prompted", endedAt: null, exitReason: null });
        if (task.state !== "running") {
          this.store.transition(taskId, "running", {
            event: { type: "task.resumed", data: { mode } },
            patch: { lastActivityAt: this.store.now(), finishedAt: null, error: null },
          });
        }
      });
      if (!needsPrompt) await this.applySnapshot(adapter, taskId, snap);
      return this.store.requireTask(taskId);
    });
  }

  /**
   * Removes a finished task's worktree and branch. Refuses when that would
   * lose work (uncommitted files, or commits that exist on no other branch or
   * remote) unless forced; only a human may force.
   */
  /** Live Claude Code / Codex workers: they die with the supervisor, so a restart interrupts them. */
  processOwnedWorkers(): { taskId: string; title: string; harness: string }[] {
    return this.store
      .listTasks({ state: [...LIVE_STATES], limit: 500 })
      .filter((t) => this.adapters.get(t.harness)?.sessionsSurviveSupervisor === false)
      .map((t) => ({ taskId: t.id, title: t.title, harness: t.harness }));
  }

  /**
   * autoCleanup: removes the worktrees of tasks finished more than afterHours
   * ago the way `ocd task cleanup` does, never forced; one whose work would be
   * lost is kept (and not retried until the next start).
   */
  async autoCleanup(): Promise<string[]> {
    const settings = this.o.config.autoCleanup;
    if (!settings.enabled || this.stopped) return [];
    const cutoff = this.o.clock() - settings.afterHours * 3_600_000;
    const due = this.store
      .listTasks({ state: ["completed", "cancelled"], limit: 500 })
      .filter(
        (t) =>
          t.workspacePath &&
          !this.keptByAutoCleanup.has(t.id) &&
          Date.parse(t.finishedAt ?? t.updatedAt) <= cutoff,
      );
    const cleaned: string[] = [];
    for (const task of due) {
      if (this.stopped) break;
      try {
        await this.cleanup(task.id, false, "manager", { auto: true });
        cleaned.push(task.id);
      } catch (error) {
        this.keptByAutoCleanup.add(task.id);
        this.log.info(
          { taskId: task.id, reason: error instanceof Error ? error.message : String(error) },
          "automatic cleanup kept a worktree",
        );
      }
    }
    if (cleaned.length) this.log.info({ tasks: cleaned }, "automatic cleanup removed worktrees");
    return cleaned;
  }

  async cleanup(
    taskId: string,
    force: boolean,
    actor: Actor,
    options: { auto?: boolean } = {},
  ): Promise<Task> {
    if (force && actor !== "human")
      throw forbidden("human_only", "Only a human can force a cleanup that discards work");
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (task.state !== "completed" && task.state !== "cancelled") {
        throw conflict(
          "not_finished",
          `Only completed or cancelled tasks can be cleaned up (task is ${task.state})`,
        );
      }
      const repo = this.store.requireRepo(task.repo, { includeRetired: true });
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
      this.store.patchTask(
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
      return this.store.requireTask(taskId);
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
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
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
      const repo = this.store.requireRepo(task.repo, { includeRetired: true });
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
      this.store.patchTask(
        taskId,
        { pullRequestUrl: url },
        {
          type: "pull_request.opened",
          data: { url, base, draft: options.draft, actor, existing: existing ?? false },
        },
      );
      return this.store.requireTask(taskId);
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
      await this.withTaskLock(taskId, () => this.mergePullRequestLocked(taskId, options, actor))
    ).task;
  }

  private async mergePullRequestLocked(
    taskId: string,
    options: { method?: MergeMethod | undefined },
    actor: Actor,
  ): Promise<{ task: Task; merged: boolean; keptReason: string | null }> {
    {
      const task = this.store.requireTask(taskId);
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
      const repo = this.store.requireRepo(task.repo, { includeRetired: true });
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
          this.store.appendEvent(taskId, "pull_request.merge_requested", { url, method, actor });
          return { task: this.store.requireTask(taskId), merged: false, keptReason: null };
        }
      }
      this.o.onLanded?.(task.repo);
      // Merged on GitHub. Local copies go only if nothing exists beyond what GitHub merged:
      // commits added after the push and uncommitted edits stay.
      const branch = task.branch ?? this.o.workspaces.branchFor(taskId);
      const keptReason = await this.localWorkBeyondMerge(task, repo.path, branch, status.headSha);
      if (keptReason) {
        this.store.appendEvent(taskId, "pull_request.merged", {
          url,
          method,
          actor,
          worktreeKept: true,
          reason: keptReason,
          remoteBranchDeleted: false,
        });
        return { task: this.store.requireTask(taskId), merged: true, keptReason };
      }
      try {
        await this.o.workspaces.remove(repo.path, task.workspacePath, branch, true);
      } catch (error) {
        // The merge itself succeeded; keep the copies and say why.
        const reason = `Could not remove the worktree: ${truncate(redact(error instanceof Error ? error.message : String(error)), 300)}`;
        this.store.appendEvent(taskId, "pull_request.merged", {
          url,
          method,
          actor,
          worktreeKept: true,
          reason,
          remoteBranchDeleted: false,
        });
        return { task: this.store.requireTask(taskId), merged: true, keptReason: reason };
      }
      const remoteDeleted = await this.o.workspaces.deleteRemoteBranch(repo.path, "origin", branch);
      this.settleLandAttention(taskId);
      this.store.patchTask(
        taskId,
        { workspacePath: null },
        {
          type: "pull_request.merged",
          data: { url, method, actor, remoteBranchDeleted: remoteDeleted },
        },
      );
      return { task: this.store.requireTask(taskId), merged: true, keptReason: null };
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

  // ---------------------------------------------------------------------------
  // Review

  /** The task's changes against where its branch started. Read-only; no task lock. */
  async diff(taskId: string): Promise<TaskDiff> {
    const task = this.store.requireTask(taskId);
    if (!task.workspacePath || !task.baseRef)
      throw conflict("no_workspace", "The task has no worktree to diff");
    const d = await this.o.workspaces.diff(task.workspacePath, task.baseRef);
    return { taskId, branch: task.branch, baseRef: task.baseRef, ...d };
  }

  /**
   * Review feedback: sent to the same worker session as a follow-up (the task
   * reopens, then comes back for review with a new report), and recorded as a
   * numbered review round.
   */
  async requestChanges(taskId: string, feedback: string, actor: Actor): Promise<Task> {
    // State check, round numbering and the send are one step under the task lock.
    return this.withTaskLock(taskId, async () => {
      const task = this.store.requireTask(taskId);
      if (task.state !== "ready_for_review")
        throw conflict(
          "not_reviewable",
          `Request changes on a task under review (task is ${task.state})`,
        );
      const round =
        this.store.events(taskId, 10_000).filter((e) => e.type === "review.changes_requested")
          .length + 1;
      const reopened = await this.sendToWorkerLocked(
        taskId,
        `Review feedback (round ${round}) on your work:\n\n${feedback}\n\nAddress it in this worktree and commit your changes.`,
      );
      this.store.appendEvent(taskId, "review.changes_requested", {
        round,
        actor,
        feedback: truncate(redact(feedback), 2000),
      });
      return reopened;
    });
  }

  // ---------------------------------------------------------------------------
  // Landing

  /** What a direct landing would push. Fetches the base branch; changes nothing. */
  async landPlan(taskId: string): Promise<LandPlan> {
    return this.planLanding(this.store.requireTask(taskId));
  }

  private async planLanding(task: Task): Promise<LandPlan> {
    if (task.state !== "ready_for_review" && task.state !== "completed")
      throw conflict("not_reviewable", `Land a task once its work is done (task is ${task.state})`);
    if (!task.workspacePath || !task.branch)
      throw conflict("no_workspace", "The task has no worktree to land");
    const repo = this.store.requireRepo(task.repo, { includeRetired: true });
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
    let task = this.store.requireTask(taskId);
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
      const repo = this.store.requireRepo(task.repo, { includeRetired: true });
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
      task = await this.accept(taskId, actor);
      steps.push("accepted");
    }
    if (!task.pullRequestUrl) {
      task = await this.openPullRequest(taskId, { draft: false, commit }, actor);
      steps.push(`opened ${task.pullRequestUrl}`);
    }
    let merged: { task: Task; merged: boolean; keptReason: string | null };
    try {
      merged = await this.withTaskLock(taskId, () =>
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
    const plan = await this.planLanding(this.store.requireTask(taskId));
    this.assertDirectLandable(plan);
    if (actor !== "human") {
      // The manager may only ask: the human confirms this exact push.
      const commits = `${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}`;
      const { attention, created } = this.store.raiseAttention(
        {
          taskId,
          kind: "land",
          dedupeKey: `land:${taskId}:${plan.head}`,
          reason: `Push ${commits} of "${truncate(plan.title, 80)}" to ${plan.remote}/${plan.base} (${plan.method})`,
          operation: plan,
          resolvableBy: "human",
          expiresAt: iso(this.o.clock() + this.o.config.attentionExpiryMinutes * 60_000),
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
        this.store.appendEvent(taskId, "land.requested", {
          actor,
          base: plan.base,
          head: plan.head,
          attention: attention.id,
        });
      return {
        task: this.store.requireTask(taskId),
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
    return this.withTaskLock(taskId, () => this.pushLanding(taskId, plan.head, actor, null));
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
  private async pushLanding(
    taskId: string,
    confirmedHead: string,
    actor: Actor,
    attentionId: string | null,
  ): Promise<LandResult> {
    const short = (sha: string) => sha.slice(0, 7);
    const plan = await this.planLanding(this.store.requireTask(taskId));
    this.assertDirectLandable(plan);
    if (plan.head !== confirmedHead)
      throw conflict(
        "plan_changed",
        `The task branch moved since the push was confirmed (${short(confirmedHead)} is now ${short(plan.head)}); confirm again`,
      );
    const task = this.store.requireTask(taskId);
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
      this.store.appendEvent(taskId, "land.failed", {
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
      this.acceptLocked(taskId, actor);
      steps.push("accepted");
    }
    steps.push(`pushed ${short(commit)} to ${target} (${plan.method})`);
    // The work is on the remote base branch now, so the local copies can go.
    const repo = this.store.requireRepo(task.repo, { includeRetired: true });
    let removed = true;
    try {
      await this.o.workspaces.remove(repo.path, workspacePath, task.branch!, true);
      steps.push("removed the worktree and branch");
    } catch (error) {
      removed = false;
      steps.push(`kept the worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.settleLandAttention(taskId, attentionId);
    this.store.patchTask(taskId, removed ? { workspacePath: null } : {}, {
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
    const landed = this.store.requireTask(taskId);
    this.o.onLanded?.(landed.repo);
    this.store.enqueue([
      this.wake(
        landed,
        `landed:${commit}`,
        `[landed] Task ${landed.id} ("${landed.title}", repo ${landed.repo}) was pushed to ${target} as ${short(commit)} (${plan.method}), confirmed by the human.${removed ? " Its worktree and branch are removed." : ""}`,
      ),
    ]);
    this.releaseWorker(landed);
    void this.tick();
    return { task: landed, landed: true, steps, waiting: null, attentionId, commit };
  }

  /**
   * Cancels the task if it is still open, then removes its worktree and
   * branch even if that loses uncommitted changes or unpushed commits.
   */
  async discard(taskId: string, reason: string | undefined, actor: Actor): Promise<Task> {
    if (actor !== "human") throw forbidden("human_only", "Only a human can discard a task's work");
    const task = this.store.requireTask(taskId);
    if (task.state !== "completed" && task.state !== "cancelled")
      await this.cancel(taskId, reason ?? "discarded");
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
      this.store.appendEvent(taskId, "pull_request.failed", {
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
    for (const a of this.store.listAttention({ taskId, status: "open", kinds: ["land"] })) {
      if (a.id !== except) this.store.settleAttention(a.id, { status: "expired" });
    }
  }

  /** Finished tasks need no live worker; process-owned harnesses stop theirs. */
  private releaseWorker(task: Task): void {
    const adapter = this.adapters.get(task.harness);
    if (!task.sessionId || !adapter?.release) return;
    adapter.release({ sessionId: task.sessionId }).catch((error: unknown) => {
      this.log.warn({ err: error, taskId: task.id }, "failed to release worker");
    });
  }

  private queueAndTick(taskId: string): Task {
    void this.tick();
    return this.store.requireTask(taskId);
  }

  // ---------------------------------------------------------------------------
  // Attention resolution

  async resolveAttention(
    id: string,
    response: AttentionResponse,
    actor: Actor,
  ): Promise<Attention> {
    const attention = this.store.requireAttention(id);
    const run = () => this.resolveAttentionLocked(id, response, actor);
    return attention.taskId ? this.withTaskLock(attention.taskId, run) : run();
  }

  private async resolveAttentionLocked(
    id: string,
    response: AttentionResponse,
    actor: Actor,
  ): Promise<Attention> {
    const attention = this.store.requireAttention(id);
    if (attention.status !== "open")
      throw conflict("not_open", `Attention request is ${attention.status}`);
    // The manager cannot self-approve a request intended for the human.
    if (attention.resolvableBy === "human" && actor !== "human") {
      throw forbidden(
        "human_only",
        "This request must be resolved by a human (ocd attention resolve)",
      );
    }
    if (attention.expiresAt && attention.expiresAt <= this.store.now()) {
      if (attention.kind === "permission" || attention.kind === "question")
        await this.expireInteraction(id);
      else this.store.settleAttention(id, { status: "expired" });
      throw new ApiError(410, "expired", "The request expired; it will not be replayed");
    }

    if (attention.kind === "permission" || attention.kind === "question") {
      if (response.type === "acknowledge")
        throw badRequest("bad_response", "Approve, deny, or answer this request");
      if (attention.kind === "permission" && response.type === "answer")
        throw badRequest("bad_response", "Permissions take approve or deny");
      if (attention.kind === "question" && response.type === "approve")
        throw badRequest("bad_response", "Questions take an answer or deny");
      const task = attention.taskId ? this.store.requireTask(attention.taskId) : null;
      const latestRun = task ? this.store.latestRun(task.id) : null;
      const adapter = task ? this.adapters.get(task.harness) : undefined;
      // Bind to the originating harness, task, live session, run, and request.
      const bound =
        task &&
        adapter &&
        task.harness === attention.harness &&
        task.sessionId === attention.sessionId &&
        latestRun?.id === this.store.attentionRunId(id) &&
        LIVE_STATES.has(task.state);
      const snap =
        bound && attention.sessionId
          ? await adapter.inspect({ sessionId: attention.sessionId }).catch(() => null)
          : null;
      if (!bound || !snap || !snap.pending.some((p) => p.id === attention.requestRef)) {
        this.store.settleAttention(id, { status: "expired" });
        throw conflict(
          "stale_request",
          "The originating request is no longer live; it was not replayed",
        );
      }
      await adapter!.reply({ sessionId: attention.sessionId! }, attention.requestRef!, response);
      const settled = this.store.settleAttention(id, {
        status: "resolved",
        response,
        resolvedBy: actor,
      });
      this.store.appendEvent(task!.id, "attention.resolved", {
        id,
        response: response.type,
        actor,
      });
      this.unblockIfClear(task!.id);
      return settled;
    }

    if (attention.kind === "land" && attention.taskId) {
      if (response.type !== "approve" && response.type !== "deny")
        throw badRequest("bad_response", "Approve or deny this push");
      const task = this.store.requireTask(attention.taskId);
      if (response.type === "approve") {
        // Pushes exactly what was asked for, or refuses (the request stays open).
        const head = (attention.operation as { head?: unknown } | null)?.head;
        if (typeof head !== "string") throw conflict("stale_request", "The request has no plan");
        await this.pushLanding(task.id, head, actor, id);
      } else {
        this.store.enqueue([
          this.wake(
            task,
            `land-declined:${id}`,
            `[land] The human declined pushing task ${task.id} ("${task.title}") directly${response.message ? `: ${response.message}` : ""}. Do not ask again unless they say so.`,
          ),
        ]);
      }
    }

    const settled = this.store.settleAttention(id, {
      status: "resolved",
      response,
      resolvedBy: actor,
    });
    if (attention.taskId)
      this.store.appendEvent(attention.taskId, "attention.resolved", {
        id,
        response: response.type,
        actor,
      });
    return settled;
  }
}
