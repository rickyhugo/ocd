import type { Attention, Task } from "@ocd/core";

// The sidebar's view model: what to show, in which order, with which emphasis.
// Pure, so it is tested without a terminal.

export type SectionKey = "needs" | "review" | "running" | "stuck" | "queued";
export type Tone = "warning" | "success" | "accent" | "error" | "muted";

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
  tone: Tone;
  rows: Row[];
  /** Open unless the human toggled it: urgent sections open, background ones closed. */
  openByDefault: boolean;
}

export interface SidebarModel {
  sections: Section[];
  /** One line for the header, zero counts left out. */
  summary: { text: string; tone: Tone }[];
  /** Human-resolvable attention items; shown even when the sidebar is collapsed. */
  urgent: Row[];
}

/** No activity for this long marks a running task as quiet. */
export const QUIET_MS = 10 * 60_000;

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
};

/** Attention kinds that stop work until the human answers. */
const BLOCKING = new Set<Attention["kind"]>([
  "permission",
  "question",
  "decision",
  "ambiguous_launch",
]);

export function buildSidebar(tasks: Task[], attention: Attention[], now: number): SidebarModel {
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

  const review = rows(
    (t) => t.state === "ready_for_review",
    (t) => ({ glyph: "✓", tone: "success", meta: age(t.finishedAt ?? t.updatedAt, now) }),
  );
  const running = rows(
    (t) => t.state === "running" || t.state === "starting" || t.state === "blocked",
    (t) => {
      const quiet = t.lastActivityAt !== null && now - Date.parse(t.lastActivityAt) > QUIET_MS;
      return {
        glyph: t.state === "blocked" ? "‖" : "▸",
        tone: quiet || t.state === "blocked" ? "muted" : "accent",
        meta: quiet ? `quiet ${age(t.lastActivityAt, now)}` : age(t.startedAt ?? t.createdAt, now),
      };
    },
  );
  const stuck = rows(
    (t) => t.state === "failed" || t.state === "interrupted" || t.state === "needs_attention",
    (t) => ({
      glyph: t.state === "failed" ? "✗" : t.state === "interrupted" ? "■" : "!",
      tone: "error",
      meta: t.state === "needs_attention" ? "attention" : t.state,
    }),
  );
  const queued = rows(
    (t) => t.state === "queued",
    (t) => ({ glyph: "·", tone: "muted", meta: age(t.createdAt, now) }),
  );

  const sections: Section[] = [
    {
      key: "needs" as const,
      label: "Needs you",
      tone: "warning" as const,
      rows: needs,
      openByDefault: true,
    },
    {
      key: "review" as const,
      label: "Review",
      tone: "success" as const,
      rows: review,
      openByDefault: true,
    },
    {
      key: "stuck" as const,
      label: "Stuck",
      tone: "error" as const,
      rows: stuck,
      openByDefault: true,
    },
    {
      key: "running" as const,
      label: "Running",
      tone: "accent" as const,
      rows: running,
      openByDefault: running.length <= 5,
    },
    {
      key: "queued" as const,
      label: "Queued",
      tone: "muted" as const,
      rows: queued,
      openByDefault: false,
    },
  ].filter((s) => s.rows.length > 0);

  const summary: { text: string; tone: Tone }[] = [];
  if (needs.length) summary.push({ text: `${needs.length} need you`, tone: "warning" });
  if (stuck.length) summary.push({ text: `${stuck.length} stuck`, tone: "error" });
  if (review.length) summary.push({ text: `${review.length} to review`, tone: "success" });
  if (running.length) summary.push({ text: `${running.length} running`, tone: "accent" });
  if (queued.length) summary.push({ text: `${queued.length} queued`, tone: "muted" });
  if (!summary.length) summary.push({ text: "idle", tone: "muted" });

  return { sections, summary, urgent: needs };
}

export type QuickAction =
  | { label: string; message: string }
  | { label: string; kind: "message" | "details" };

/** What clicking a row offers. Quick actions are messages to the manager, which acts on them. */
export function actionsFor(row: Row): QuickAction[] {
  const message = { label: "Message the manager about it…", kind: "message" as const };
  const details = { label: "Details", kind: "details" as const };
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
  switch (row.task?.state) {
    case "ready_for_review":
      return [
        {
          label: "Summarize the result",
          message: "Summarize the result and anything I should check before accepting.",
        },
        { label: "Accept it", message: "I've reviewed it: accept it." },
        { label: "Accept and open a PR", message: "Accept it and open a pull request." },
        message,
        details,
      ];
    case "running":
    case "starting":
    case "blocked":
      return [
        { label: "Status update", message: "How is it going? Give me a short status update." },
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
        message,
        details,
      ];
    default:
      return [message, { label: "Cancel it", message: "Cancel this task." }, details];
  }
}
