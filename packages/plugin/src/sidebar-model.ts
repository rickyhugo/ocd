import type { Attention, Task, UpdateStatus } from "@ocd/core";

// The sidebar's view model: what to show, in which order, with which emphasis.
// Pure, so it is tested without a terminal.

export type SectionKey = "needs" | "manual" | "review" | "stuck" | "running" | "queued" | "recent";
export type Tone = "warning" | "success" | "accent" | "error" | "muted" | "info";

export interface Row {
  key: string;
  glyph: string;
  tone: Tone;
  title: string;
  /** Short right-aligned detail: age, attention kind. */
  meta: string;
  task: Task | null;
  attention: Attention | null;
}

export interface Section {
  key: SectionKey;
  label: string;
  glyph: string;
  tone: Tone;
  rows: Row[];
  /** Open unless the human toggled it: urgent sections open, background ones closed. */
  openByDefault: boolean;
}

export interface SidebarModel {
  /** Sections with open work, most urgent first, then recently finished work. */
  sections: Section[];
  /** Compact header counts ("! 1  ✓ 2  ● 3"), one per non-empty open-work section. */
  counts: { glyph: string; count: number; tone: Tone; label: string }[];
  /** Human-resolvable attention items; shown even when the sidebar is collapsed. */
  urgent: Row[];
  /** No open work: the sidebar shows "idle" and recent work instead of sections. */
  idle: boolean;
  recent: Row[];
}

/** No activity for this long marks a running task as quiet. */
export const QUIET_MS = 10 * 60_000;
/** Finished tasks stay under "Done" this long. */
export const RECENT_MS = 24 * 3_600_000;
const RECENT_MAX = 5;

/** "now", "4m", "2h", "3d". */
export function age(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

const ATTENTION_LABEL: Record<Attention["kind"], string> = {
  permission: "permission",
  question: "question",
  decision: "decision",
  failure: "failed",
  stall: "stalled",
  review: "review",
  ambiguous_launch: "unclear",
  land: "confirm push",
};

/** Attention kinds that stop work until the human answers. */
const BLOCKING = new Set<Attention["kind"]>([
  "permission",
  "question",
  "decision",
  "ambiguous_launch",
  "land",
]);

/**
 * @param tasks open tasks (anything not completed or cancelled)
 * @param finished recently completed or cancelled tasks, newest first
 */
export function buildSidebar(
  tasks: Task[],
  attention: Attention[],
  now: number,
  finished: Task[] = [],
): SidebarModel {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const human = attention.filter((a) => a.status === "open" && a.resolvableBy === "human");
  // Blocking items go to "Needs you". Review, failure and stall items belong to
  // their task's own section (Review, Stuck), so a task is listed once.
  const blocking = human.filter((a) => BLOCKING.has(a.kind) || !a.taskId || !byId.has(a.taskId));
  const waitingOnHuman = new Set(blocking.flatMap((a) => (a.taskId ? [a.taskId] : [])));

  const needs: Row[] = blocking
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((a) => {
      const task = a.taskId ? (byId.get(a.taskId) ?? null) : null;
      return {
        key: a.id,
        glyph: "!",
        tone: "warning",
        title: task?.title ?? a.reason,
        meta: ATTENTION_LABEL[a.kind],
        task,
        attention: a,
      };
    });

  const rows = (
    filter: (t: Task) => boolean,
    row: (t: Task) => Omit<Row, "key" | "title" | "task" | "attention">,
  ) =>
    tasks
      .filter((t) => !waitingOnHuman.has(t.id) && filter(t))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => ({ key: t.id, title: t.title, task: t, attention: null, ...row(t) }));

  const manual = rows(
    (t) => t.state === "manual",
    (t) => ({ glyph: "◆", tone: "info", meta: `you · ${age(t.updatedAt, now)}` }),
  );
  const review = rows(
    (t) => t.state === "ready_for_review",
    (t) => ({ glyph: "✓", tone: "success", meta: age(t.finishedAt ?? t.updatedAt, now) }),
  );
  const running = rows(
    (t) => t.state === "running" || t.state === "starting" || t.state === "blocked",
    (t) => {
      const quiet = t.lastActivityAt !== null && now - Date.parse(t.lastActivityAt) > QUIET_MS;
      return {
        glyph: t.state === "blocked" ? "‖" : quiet ? "○" : "●",
        tone: quiet || t.state === "blocked" ? "muted" : "accent",
        meta: quiet
          ? `quiet ${age(t.lastActivityAt, now)}`
          : t.state === "starting"
            ? "starting"
            : age(t.startedAt ?? t.createdAt, now),
      };
    },
  );
  const stuck = rows(
    (t) => t.state === "failed" || t.state === "interrupted" || t.state === "needs_attention",
    (t) => ({
      glyph: "✗",
      tone: "error",
      meta: t.state === "needs_attention" ? "attention" : t.state,
    }),
  );
  const queued = rows(
    (t) => t.state === "queued",
    (t) => ({ glyph: "·", tone: "muted", meta: age(t.createdAt, now) }),
  );
  const recent: Row[] = finished
    .filter((t) => t.finishedAt && now - Date.parse(t.finishedAt) < RECENT_MS)
    .toSorted((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
    .slice(0, RECENT_MAX)
    .map((t) => ({
      key: t.id,
      glyph: t.state === "cancelled" ? "–" : "✓",
      tone: "muted",
      title: t.title,
      // A kept worktree is worth knowing about: it can be cleaned up from here.
      meta: `${t.workspacePath ? "kept · " : ""}${age(t.finishedAt, now)}`,
      task: t,
      attention: null,
    }));

  const open: Section[] = [
    {
      key: "needs",
      label: "Needs you",
      glyph: "!",
      tone: "warning",
      rows: needs,
      openByDefault: true,
    },
    {
      key: "manual",
      label: "Manual",
      glyph: "◆",
      tone: "info",
      rows: manual,
      openByDefault: true,
    },
    {
      key: "review",
      label: "Review",
      glyph: "✓",
      tone: "success",
      rows: review,
      openByDefault: true,
    },
    { key: "stuck", label: "Stuck", glyph: "✗", tone: "error", rows: stuck, openByDefault: true },
    {
      key: "running",
      label: "Running",
      glyph: "●",
      tone: "accent",
      rows: running,
      openByDefault: running.length <= 5,
    },
    {
      key: "queued",
      label: "Queued",
      glyph: "·",
      tone: "muted",
      rows: queued,
      openByDefault: false,
    },
  ];
  const nonEmpty = open.filter((s) => s.rows.length > 0);
  const idle = nonEmpty.length === 0;
  const sections: Section[] = [
    ...nonEmpty,
    ...(recent.length && !idle
      ? [
          {
            key: "recent" as const,
            label: "Done today",
            glyph: "✓",
            tone: "muted" as const,
            rows: recent,
            openByDefault: false,
          },
        ]
      : []),
  ];

  return {
    sections,
    counts: nonEmpty.map((s) => ({
      glyph: s.glyph,
      count: s.rows.length,
      tone: s.tone,
      label: s.label,
    })),
    urgent: needs,
    idle,
    recent,
  };
}

export type ActionKind =
  | "message"
  | "details"
  | "accept"
  | "clean"
  | "takeover"
  | "open"
  | "giveback_continue"
  | "giveback_review"
  | "land"
  | "land_direct"
  | "land_confirm"
  | "land_decline"
  | "discard"
  | "diff"
  | "request_changes";
/** A message goes to the manager, which acts on it; a kind runs directly against OCD. */
export type QuickAction = { label: string; message: string } | { label: string; kind: ActionKind };

/** A task whose work can still land: done, with its worktree. */
export function landable(task: Task): boolean {
  return task.state === "ready_for_review" || (task.state === "completed" && !!task.workspacePath);
}

/** The landing routes on offer; the pull request route only when pull requests are on. */
export function landingActions(options: {
  pullRequests: boolean;
}): { label: string; kind: "land" | "land_direct" }[] {
  return [
    ...(options.pullRequests
      ? [{ label: "Land through a pull request", kind: "land" as const }]
      : []),
    { label: "Land directly on the base branch…", kind: "land_direct" },
  ];
}

/**
 * What clicking a row offers, for the row's current state. `pullRequests`:
 * whether the supervisor has pull requests on (github.enabled).
 */
export function actionsFor(row: Row, options: { pullRequests: boolean }): QuickAction[] {
  const message = { label: "Message the manager about it…", kind: "message" as const };
  const details = { label: "Details", kind: "details" as const };
  if (row.attention?.kind === "land") {
    return [
      { label: "Review and confirm the push…", kind: "land_confirm" },
      { label: "Decline the push", kind: "land_decline" },
      message,
      details,
    ];
  }
  if (row.attention) {
    return [
      {
        label: "Ask the manager what it needs",
        message: "What exactly is it waiting for, and what do you recommend?",
      },
      message,
      details,
    ];
  }
  const landing = row.task && landable(row.task) ? landingActions(options) : [];
  const discard = { label: "Discard the work…", kind: "discard" as const };
  const diff = row.task?.workspacePath ? [{ label: "View the diff", kind: "diff" as const }] : [];
  // Manual mode needs a worker session to open.
  const takeover = row.task?.sessionId
    ? [{ label: "Take over (manual mode)", kind: "takeover" as const }]
    : [];
  switch (row.task?.state) {
    case "manual":
      return [
        { label: "Open the session", kind: "open" },
        ...diff,
        { label: "Give back: let the worker continue", kind: "giveback_continue" },
        { label: "Give back: ready for review", kind: "giveback_review" },
        message,
        details,
      ];
    case "ready_for_review":
      return [
        ...diff,
        ...landing,
        { label: "Request changes…", kind: "request_changes" },
        { label: "Accept (keep the worktree)", kind: "accept" },
        ...takeover,
        {
          label: "Summarize the result",
          message: "Summarize the result and anything I should check before accepting.",
        },
        message,
        discard,
        details,
      ];
    case "running":
    case "starting":
    case "blocked":
      return [
        { label: "Status update", message: "How is it going? Give me a short status update." },
        ...diff,
        ...takeover,
        message,
        { label: "Cancel it", message: "Cancel this task." },
        details,
      ];
    case "failed":
    case "interrupted":
    case "needs_attention":
      return [
        { label: "What happened?", message: "What happened, and what do you suggest?" },
        { label: "Retry it", message: "Look at what went wrong and retry it if that is safe." },
        ...diff,
        ...takeover,
        message,
        discard,
        details,
      ];
    case "completed":
    case "cancelled":
      return [
        ...(row.task.workspacePath
          ? [
              ...diff,
              ...landing,
              { label: "Clean up the worktree", kind: "clean" as const },
              discard,
            ]
          : []),
        message,
        details,
      ];
    default:
      return [message, { label: "Cancel it", message: "Cancel this task." }, details];
  }
}

/** The sidebar line for OCD updating itself; null when there is nothing to show. */
export function updateBanner(
  u: UpdateStatus | null | undefined,
): { glyph: string; tone: Tone; text: string; meta: string } | null {
  if (!u?.enabled) return null;
  const short = (sha: string) => sha.slice(0, 7);
  if (u.pending) {
    const n = u.blockedBy.length;
    return {
      glyph: "⬆",
      tone: n ? "warning" : "accent",
      text: `Update ready · ${short(u.pending.sha)}`,
      meta: n
        ? `waits for ${n} worker${n === 1 ? "" : "s"}`
        : u.cannotApply
          ? "not applied"
          : "applying",
    };
  }
  if (u.building)
    return { glyph: "⟳", tone: "muted", text: "Building an update", meta: short(u.building) };
  if (u.lastError && u.lastError.sha !== u.current)
    return { glyph: "!", tone: "error", text: "Update failed", meta: short(u.lastError.sha) };
  return null;
}
