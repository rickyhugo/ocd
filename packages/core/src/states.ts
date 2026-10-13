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
] as const;

export type TaskState = (typeof TASK_STATES)[number];

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["starting", "cancelled", "needs_attention"],
  // "queued" again only when reconciliation proves the launch was not admitted.
  starting: ["running", "queued", "failed", "interrupted", "cancelled", "needs_attention"],
  running: ["blocked", "ready_for_review", "failed", "interrupted", "cancelled", "needs_attention"],
  blocked: ["running", "failed", "interrupted", "cancelled", "needs_attention"],
  // A follow-up instruction re-opens a reviewed task; acceptance is human-only.
  ready_for_review: ["completed", "running", "cancelled"],
  needs_attention: ["running", "queued", "ready_for_review", "failed", "cancelled", "interrupted"],
  // Explicit resume either reattaches (running) or relaunches (queued).
  interrupted: ["running", "queued", "cancelled"],
  failed: ["queued", "cancelled"],
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
