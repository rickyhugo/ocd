import {
  LIVE_STATES,
  type Attention,
  type Task,
  type TaskEvent,
  type TaskEventType,
  type TaskProgress,
  type TodoItem,
} from "@ocd/core";

import { age, type Row, type Tone } from "./sidebar-model.ts";

// The expandable progress panel under a running task's sidebar row: the
// harness-reported checklist, recent lifecycle milestones and a recorded PR.
// Only facts OCD already holds; nothing is summarized or inferred. Pure, so it
// is tested without a terminal.

export interface ProgressLine {
  glyph: string;
  tone: Tone;
  text: string;
  /** Short right-aligned detail, e.g. an age. */
  meta: string;
}

/** Rows of a panel at most; longer panels scroll inside themselves. */
export const PANEL_MAX_HEIGHT = 8;
/** Recent milestones shown, newest first. */
export const MILESTONES_MAX = 6;

/** Fetched progress, or "unavailable" when the supervisor could not provide it. */
export type ProgressState = TaskProgress | "unavailable";

/** Running-task rows expand; rows about attention items keep their single click action. */
export function canExpand(row: Row): boolean {
  return !!row.task && !row.attention && LIVE_STATES.has(row.task.state);
}

export function toggleExpanded(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Forgets expansions of tasks that are no longer open. A task that moves to
 * "Needs you" and back stays expanded. Returns the same set when nothing changed.
 */
export function pruneExpanded(
  expanded: ReadonlySet<string>,
  openTaskIds: Iterable<string>,
): ReadonlySet<string> {
  const open = new Set(openTaskIds);
  const kept = [...expanded].filter((id) => open.has(id));
  return kept.length === expanded.size ? expanded : new Set(kept);
}

/** Tasks whose progress to fetch: expanded and visible right now. */
export function progressTargets(expanded: ReadonlySet<string>, visible: Row[]): string[] {
  return visible.filter((r) => canExpand(r) && expanded.has(r.key)).map((r) => r.key);
}

export function panelHeight(lines: ProgressLine[]): number {
  return Math.min(PANEL_MAX_HEIGHT, Math.max(1, lines.length));
}

/** Only an overflowing panel takes the mouse wheel; otherwise the sidebar scrolls as before. */
export function panelScrolls(lines: ProgressLine[]): boolean {
  return lines.length > PANEL_MAX_HEIGHT;
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

const field = (data: unknown, key: string): unknown =>
  data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;

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

/** "github.com/o/r/pull/12" -> "o/r#12"; other hosts lose only the scheme. */
export function shortPullRequest(url: string): string {
  const github = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return github ? `${github[1]}#${github[2]}` : url.replace(/^https?:\/\//, "");
}

const TODO: Record<TodoItem["status"], { glyph: string; tone: Tone }> = {
  completed: { glyph: "✓", tone: "success" },
  in_progress: { glyph: "▸", tone: "accent" },
  pending: { glyph: "○", tone: "muted" },
  cancelled: { glyph: "–", tone: "muted" },
};

function checklist(task: Task, progress: TaskProgress): ProgressLine[] {
  const todos = progress.todos;
  if (!todos) {
    const text = progress.todosSupported
      ? "No checklist reported yet"
      : `No checklist from ${task.harness}`;
    return [{ glyph: "○", tone: "muted", text, meta: "" }];
  }
  if (!todos.length) return [{ glyph: "○", tone: "muted", text: "Checklist is empty", meta: "" }];
  const done = todos.filter((t) => t.status === "completed").length;
  return [
    { glyph: "☰", tone: "muted", text: `Checklist ${done}/${todos.length}`, meta: "" },
    ...todos.map((t) => ({ ...TODO[t.status], text: t.text, meta: "" })),
  ];
}

function milestones(events: TaskEvent[], now: number): ProgressLine[] {
  const lines: ProgressLine[] = [];
  for (const event of events) {
    const text = milestone(event);
    // Repeats (a stall raised twice) say nothing new; keep the latest.
    if (text && lines.at(-1)?.text === text) lines.pop();
    if (text) lines.push({ glyph: "·", tone: "muted", text, meta: age(event.createdAt, now) });
  }
  return lines.slice(-MILESTONES_MAX).reverse();
}

/** The panel's lines: PR, checklist, then recent milestones. */
export function progressLines(
  task: Task,
  progress: ProgressState | undefined,
  now: number,
): ProgressLine[] {
  const lines: ProgressLine[] = [];
  if (task.pullRequestUrl)
    lines.push({
      glyph: "⇡",
      tone: "info",
      text: `PR ${shortPullRequest(task.pullRequestUrl)}`,
      meta: "",
    });
  if (progress === undefined) {
    lines.push({ glyph: "…", tone: "muted", text: "Loading progress", meta: "" });
  } else if (progress === "unavailable") {
    lines.push({ glyph: "○", tone: "muted", text: "Progress unavailable", meta: "" });
  } else {
    lines.push(...checklist(task, progress), ...milestones(progress.events, now));
  }
  return lines;
}
