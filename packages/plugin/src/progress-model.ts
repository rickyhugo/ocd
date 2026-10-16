import {
  STAGE_LABEL,
  liveness,
  milestone,
  type Task,
  type TaskEvent,
  type TaskProgress,
  type TaskView,
  type TodoItem,
} from "@ocd/core";

import { age, type Row, type Tone } from "./sidebar-model.ts";

// The expandable progress panel under a running task's sidebar row: the
// lifecycle stage and whether the worker is still heard from, a recorded PR,
// the harness-reported checklist and recent lifecycle milestones. Only facts
// OCD already holds; nothing is summarized, inferred or estimated. Pure, so it
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

/** States whose row can expand: a worker is (or is about to be) working. */
const EXPANDABLE = new Set<Task["state"]>(["running", "starting", "blocked"]);

/** Running-task rows expand; rows about attention items keep their single click action. */
export function canExpand(row: Row): boolean {
  return !!row.task && !row.attention && EXPANDABLE.has(row.task.state);
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
    {
      glyph: "☰",
      tone: "muted",
      text: `Checklist (worker-reported) ${done}/${todos.length}`,
      meta: "",
    },
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

function stage(task: TaskView, now: number): ProgressLine[] {
  const lc = task.lifecycle;
  const lines: ProgressLine[] = [
    {
      glyph: lc.stage === "blocked" ? "‖" : "●",
      tone: lc.stage === "blocked" ? "muted" : "accent",
      text: STAGE_LABEL[lc.stage],
      meta: age(lc.since, now),
    },
  ];
  const live = liveness(task, now);
  if (live.kind === "live")
    lines.push({
      glyph: "·",
      tone: "muted",
      text: "Last worker signal",
      meta: age(live.lastSignalAt, now),
    });
  if (live.kind === "stale")
    lines.push({
      glyph: "○",
      tone: "warning",
      text: `No progress signal for ${age(live.quietSince, now)}`,
      meta: "",
    });
  return lines;
}

/** Said instead of a blank panel; the stage lines above still come from the task itself. */
function historyUnavailable(task: TaskView, now: number): ProgressLine[] {
  const last = task.lifecycle.lastMilestone;
  return [
    { glyph: "○", tone: "muted", text: "Activity history unavailable", meta: "" },
    ...(last
      ? [{ glyph: "·", tone: "muted" as const, text: last.label, meta: age(last.at, now) }]
      : []),
  ];
}

/** The panel's lines: stage and liveness, PR, checklist, then recent milestones. */
export function progressLines(
  task: TaskView,
  progress: ProgressState | undefined,
  now: number,
): ProgressLine[] {
  const lines = stage(task, now);
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
    lines.push(...historyUnavailable(task, now));
  } else {
    lines.push(...checklist(task, progress), ...milestones(progress.events, now));
    if (!progress.todos && !progress.events.length) lines.push(...historyUnavailable(task, now));
  }
  return lines;
}
