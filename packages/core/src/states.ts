// Task lifecycle. Transitions not listed here are rejected by the supervisor.
export const TASK_STATES = [
  "queued",
  "starting",
  "running",
  "blocked",
  "ready_for_review",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "needs_attention",
  // The human took over the worker's session and drives it directly.
  "manual",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

// Status families other than task state. The persisted strings are in users'
// databases and the API; the supervisor schema, store and wire schemas share
// these lists (zod enums and types live in schemas.ts).

/** A worker run: launching until the harness session is confirmed, then until it ends. */
export const RUN_STATES = ["launching", "acknowledged", "prompted", "ended", "lost"] as const;

export const ATTENTION_STATUSES = ["open", "resolved", "expired", "rejected"] as const;

export const MEMORY_STATUSES = ["proposed", "confirmed", "retired"] as const;

export const OUTBOX_KINDS = ["notify", "manager_wake"] as const;

export const OUTBOX_STATUSES = ["pending", "delivered", "dead"] as const;

/**
 * What a task works in, chosen at dispatch and fixed for the task's life.
 * isolated: OCD's own task branch and worktree. none: no repository checkout,
 * only a scratch directory (research, external actions such as filing an issue).
 */
export const WORKSPACE_MODES = ["isolated", "none"] as const;

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface WorkspaceCapabilities {
  /** OCD owns a task branch and worktree: git verification, diff, branch sync and cleanup apply. */
  worktree: boolean;
  /** The work can land (pull request, merge, direct push). */
  land: boolean;
  /** A human can take over the worker session (manual mode). */
  takeOver: boolean;
}

// Supervisor, CLI and sidebar decide what a task allows from this table, never from the mode itself.
export const WORKSPACE_CAPABILITIES = {
  isolated: { worktree: true, land: true, takeOver: true },
  none: { worktree: false, land: false, takeOver: false },
} as const satisfies Record<WorkspaceMode, WorkspaceCapabilities>;

export function capabilitiesOf(task: { workspaceMode: WorkspaceMode }): WorkspaceCapabilities {
  return WORKSPACE_CAPABILITIES[task.workspaceMode];
}

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["starting", "cancelled", "needs_attention"],
  // "queued" again only when reconciliation proves the launch was not admitted.
  starting: ["running", "queued", "failed", "interrupted", "cancelled", "needs_attention"],
  running: [
    "blocked",
    "ready_for_review",
    "failed",
    "interrupted",
    "cancelled",
    "needs_attention",
    "manual",
  ],
  // A blocked worker can still finish (e.g. a request was answered in the harness UI).
  blocked: [
    "running",
    "ready_for_review",
    "failed",
    "interrupted",
    "cancelled",
    "needs_attention",
    "manual",
  ],
  // A follow-up instruction re-opens a reviewed task; acceptance is human-only.
  ready_for_review: ["completed", "running", "cancelled", "manual"],
  needs_attention: [
    "running",
    "queued",
    "ready_for_review",
    "failed",
    "cancelled",
    "interrupted",
    "manual",
  ],
  // Explicit resume either reattaches (running) or relaunches (queued).
  interrupted: ["running", "queued", "cancelled", "manual"],
  // Reattaching to a failed worker's session, or relaunching it.
  failed: ["running", "queued", "cancelled", "manual"],
  // Handed back: the worker continues (running) or the human is done (ready_for_review).
  manual: ["running", "ready_for_review", "cancelled"],
  completed: [],
  cancelled: [],
};

/** States in which a worker may own the task's workspace. */
export const LIVE_STATES: ReadonlySet<TaskState> = new Set(["starting", "running", "blocked"]);

/** States that are not finished: shown in briefings and status. */
export const OPEN_STATES: ReadonlySet<TaskState> = new Set([
  "queued",
  "starting",
  "running",
  "blocked",
  "ready_for_review",
  "needs_attention",
  "interrupted",
  "failed",
  "manual",
]);

/** States from which the human can take over a worker's session. */
export const TAKEOVER_STATES: ReadonlySet<TaskState> = new Set([
  "running",
  "blocked",
  "ready_for_review",
  "needs_attention",
  "interrupted",
  "failed",
]);

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "cancelled"]);

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: TaskState;
  readonly to: TaskState;

  constructor(from: TaskState, to: TaskState) {
    super(`Invalid task transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
