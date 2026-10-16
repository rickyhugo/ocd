import type { TaskEventType } from "./events.ts";
import type { Attention, Task, TaskEvent } from "./schemas.ts";
import { TASK_STATES, type TaskState } from "./states.ts";

// A task's lifecycle stages and their timings, derived at read time from the
// event log. The task's state stays the authority; stages refine "starting"
// and "running" into what the human waits on.

export const STAGES = [
  "queued",
  "preparing_workspace",
  "starting_worker",
  "working",
  "blocked",
  "review",
  "manual",
  "stopped",
  "done",
] as const;

export type Stage = (typeof STAGES)[number];

/** Exhaustive over TaskState; the fold refines starting and running. */
const STATE_STAGE: Record<TaskState, Stage> = {
  queued: "queued",
  starting: "preparing_workspace",
  running: "working",
  blocked: "blocked",
  ready_for_review: "review",
  manual: "manual",
  failed: "stopped",
  interrupted: "stopped",
  needs_attention: "stopped",
  completed: "done",
  cancelled: "done",
};

export const STAGE_LABEL: Record<Stage, string> = {
  queued: "Queued",
  preparing_workspace: "Preparing workspace",
  starting_worker: "Starting worker",
  working: "Working",
  blocked: "Blocked",
  review: "Review / landing",
  manual: "Manual",
  stopped: "Stopped",
  done: "Done",
};

/** A live stage with no worker signal for this long shows as stale (display only; checkStall's stall attention is separate). */
export const STALE_AFTER_MS = 10 * 60_000;

const LIVE_STAGES: ReadonlySet<Stage> = new Set([
  "preparing_workspace",
  "starting_worker",
  "working",
]);

export interface StageSpan {
  stage: Stage;
  attempt: number;
  from: string;
  to: string | null;
}

/** Clock-free facts derived from the event log; readers apply their own `now`. */
export interface TaskLifecycle {
  stage: Stage;
  since: string;
  attempt: number;
  /** Oldest first; the last one is open (to: null) unless the stage is done. */
  spans: StageSpan[];
  lastMilestone: { label: string; at: string } | null;
  lastEventAt: string | null;
}

/** A task as list and inspect return it. */
export type TaskView = Task & { lifecycle: TaskLifecycle };

export type Liveness =
  | { kind: "not_live" }
  | { kind: "live"; lastSignalAt: string }
  | { kind: "stale"; quietSince: string };

const field = (data: unknown, key: string): unknown =>
  data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;

const STATES: ReadonlySet<unknown> = new Set(TASK_STATES);

/** The state a transition event moved to; null for other events. Any event type can record a transition. */
export function transitionTo(event: TaskEvent): TaskState | null {
  const to = field(event.data, "to");
  return STATES.has(to) ? (to as TaskState) : null;
}

export function taskLifecycle(task: Task, events: readonly TaskEvent[]): TaskLifecycle {
  const spans: StageSpan[] = [];
  let attempt = 0;
  let responded = false;
  let target: TaskState = "queued";
  let lastMilestone: TaskLifecycle["lastMilestone"] = null;
  const enter = (stage: Stage, at: string) => {
    const open = spans.at(-1);
    if (open?.stage === stage) return;
    if (open) open.to = at;
    spans.push({ stage, attempt, from: at, to: null });
  };
  const current = () => spans.at(-1)?.stage;

  enter("queued", task.createdAt);
  for (const e of events) {
    const label = milestone(e);
    if (label) lastMilestone = { label, at: e.createdAt };
    const to = transitionTo(e);
    if (to) {
      target = to;
      if (to === "starting") {
        attempt += 1;
        responded = false;
        enter("preparing_workspace", e.createdAt);
      } else if (to === "running") {
        enter(responded ? "working" : "starting_worker", e.createdAt);
      } else {
        enter(STATE_STAGE[to], e.createdAt);
      }
    } else if (e.type === "workspace.ready" && current() === "preparing_workspace") {
      enter("starting_worker", e.createdAt);
    } else if (e.type === "worker.responded") {
      responded = true;
      if (current() === "starting_worker" && target === "running") enter("working", e.createdAt);
    }
  }
  if (target !== task.state) enter(STATE_STAGE[task.state], task.updatedAt);

  const last = spans.at(-1)!;
  if (last.stage === "done") last.to = last.from;
  return {
    stage: last.stage,
    since: last.from,
    attempt,
    spans,
    lastMilestone,
    lastEventAt: events.at(-1)?.createdAt ?? null,
  };
}

/** Milliseconds spent in each stage, the open span counted to `now`; "done" is excluded. */
export function stageTimings(lc: TaskLifecycle, now: number): Partial<Record<Stage, number>> {
  const totals: Partial<Record<Stage, number>> = {};
  for (const span of lc.spans) {
    if (span.stage === "done") continue;
    const end = span.to === null ? now : Date.parse(span.to);
    totals[span.stage] = (totals[span.stage] ?? 0) + Math.max(0, end - Date.parse(span.from));
  }
  return totals;
}

/** Whether a live stage still hears from its worker; the stage start counts as a signal. */
export function liveness(task: TaskView, now: number): Liveness {
  const lc = task.lifecycle;
  if (!LIVE_STAGES.has(lc.stage)) return { kind: "not_live" };
  const at = task.lastActivityAt && task.lastActivityAt > lc.since ? task.lastActivityAt : lc.since;
  return now - Date.parse(at) > STALE_AFTER_MS
    ? { kind: "stale", quietSince: at }
    : { kind: "live", lastSignalAt: at };
}

/** "<1s", "12s", "4m 12s", "2h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Stage, timings and last milestone as plain lines for the CLI and the manager. Facts only, never an estimate. */
export function lifecycleLines(task: TaskView, now: number): string[] {
  const lc = task.lifecycle;
  const since = (iso: string) => formatDuration(now - Date.parse(iso));
  const live = liveness(task, now);
  const signal =
    live.kind === "live"
      ? ` · last worker signal ${since(live.lastSignalAt)} ago`
      : live.kind === "stale"
        ? ` · no progress signal for ${since(live.quietSince)}`
        : "";
  const timings = stageTimings(lc, now);
  const lines = [
    `stage: ${STAGE_LABEL[lc.stage]} ${since(lc.since)}${lc.attempt > 1 ? ` (attempt ${lc.attempt})` : ""}${signal}`,
    `timings: ${STAGES.filter((s) => timings[s] !== undefined)
      .map((s) => `${STAGE_LABEL[s].toLowerCase()} ${formatDuration(timings[s]!)}`)
      .join(" · ")}`,
  ];
  if (lc.lastMilestone)
    lines.push(`last milestone: ${lc.lastMilestone.label} ${since(lc.lastMilestone.at)} ago`);
  return lines;
}

const ATTENTION: Record<Attention["kind"], string> = {
  permission: "Asked for permission",
  question: "Asked a question",
  decision: "Decision needed",
  failure: "Failure reported",
  stall: "Looks stalled",
  review: "Ready for review",
  ambiguous_launch: "Launch unclear",
  land: "Push waiting for your confirmation",
};

// null: deliberately no line (bookkeeping, or labelled in milestone() because it depends on data).
const MILESTONE: Record<TaskEventType, string | null> = {
  "task.created": "Queued",
  "task.accepted": "Accepted",
  "task.cancelled": "Cancelled",
  "task.landed": "Landed",
  "task.taken_over": "Taken over by you",
  "task.given_back": "Handed back",
  "task.resumed": "Resumed",
  "workspace.ready": null,
  "workspace.cleaned": null,
  "session.created": null,
  "session.missing": "Session missing",
  "launch.intent": null,
  "launch.deferred": "Launch deferred",
  "launch.not_admitted": "Launch not admitted",
  "launch.ambiguous": "Launch unclear",
  "prompt.intent": "Instructions sent",
  "worker.responded": "Worker responded",
  "worker.steered": "Follow-up sent",
  "worker.lost": "Worker lost",
  "shutdown.interrupted": "Stopped by shutdown",
  "dependency.cancelled": "Dependency cancelled",
  "quota.limited": "Usage limit reached",
  "interaction.pending": "Waiting for an answer",
  "permission.yolo_approved": null,
  "permission.auto_approve_failed": null,
  "attention.raised": null,
  "attention.resolved": "Request answered",
  "attention.expired": "Request expired",
  "decision.recorded": "Decision recorded",
  "pull_request.opened": "PR opened",
  "pull_request.merge_requested": "PR merge requested",
  "pull_request.merged": "PR merged",
  "pull_request.failed": "PR failed",
  "review.changes_requested": "Changes requested",
  "land.requested": "Push awaiting confirmation",
  "land.failed": "Push failed",
  "branch_sync.intent": null,
  "branch_sync.intent_dropped": null,
  "branch_sync.conflict": null,
  "branch_sync.failed": null,
  "branch_sync.refreshed": null,
  "branch_sync.follow_up_not_sent": null,
  "state.queued": null,
  "state.starting": "Starting",
  "state.running": null,
  "state.blocked": "Blocked",
  "state.ready_for_review": "Ready for review",
  "state.completed": "Completed",
  "state.failed": "Failed",
  "state.interrupted": "Interrupted",
  "state.cancelled": "Cancelled",
  "state.needs_attention": "Needs attention",
  "state.manual": null,
};

/** A short label for a lifecycle event; null for events not worth a line. */
export function milestone(event: TaskEvent): string | null {
  switch (event.type) {
    case "launch.intent": {
      const attempt = field(event.data, "attempt");
      return typeof attempt === "number" && attempt > 1
        ? `Worker launching (attempt ${attempt})`
        : "Worker launching";
    }
    case "state.running":
      return field(event.data, "from") === "blocked" ? "Unblocked" : "Running";
    case "attention.raised": {
      const kind = field(event.data, "kind") as Attention["kind"] | undefined;
      return (kind && ATTENTION[kind]) ?? "Attention raised";
    }
    default:
      return MILESTONE[event.type] ?? null;
  }
}
