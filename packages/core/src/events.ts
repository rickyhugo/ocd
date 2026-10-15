import type { TaskState } from "./states.ts";

// Task event types: what the supervisor appends to a task's log and what the
// plugin and spill summaries label. Persisted as-is, so renaming one orphans
// the rows already written; add new types instead.

export const TASK_EVENT_TYPES = [
  "task.created",
  "task.accepted",
  "task.cancelled",
  "task.landed",
  "task.taken_over",
  "task.given_back",
  "task.resumed",
  "workspace.ready",
  "workspace.cleaned",
  "session.created",
  "session.missing",
  "launch.intent",
  "launch.deferred",
  "launch.not_admitted",
  "launch.ambiguous",
  "prompt.intent",
  "worker.steered",
  "worker.lost",
  "shutdown.interrupted",
  "dependency.cancelled",
  "quota.limited",
  "interaction.pending",
  "permission.yolo_approved",
  "permission.auto_approve_failed",
  "attention.raised",
  "attention.resolved",
  "attention.expired",
  "decision.recorded",
  "pull_request.opened",
  "pull_request.merge_requested",
  "pull_request.merged",
  "pull_request.failed",
  "review.changes_requested",
  "land.requested",
  "land.failed",
  "branch_sync.intent",
  "branch_sync.intent_dropped",
  "branch_sync.conflict",
  "branch_sync.failed",
  "branch_sync.refreshed",
  "branch_sync.follow_up_not_sent",
] as const;

/** The event a transition records unless the caller names a more specific one. */
export type StateEventType = `state.${TaskState}`;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number] | StateEventType;
