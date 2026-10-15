import type { OcdClient } from "./client.ts";
import { redact, truncate } from "./redact.ts";
import type { TaskEventType } from "./events.ts";
import type { Attention, AttentionKind, Task, TaskEvent } from "./schemas.ts";
import { OPEN_STATES, type TaskState } from "./states.ts";

// `/spill` and `ocd spill`: a read-only snapshot of all open work, built only
// from supervisor records (task rows, open attention, task events). No model
// call, no transcript, no worker-authored summaries; nothing here writes.

export type SpillSectionKey = "running" | "waiting" | "manual" | "stuck" | "queued" | "review";

export interface SpillEntry {
  /** Task id, or attention id for an item not tied to open work. */
  ref: string;
  title: string;
  repo: string | null;
  state: TaskState | null;
  /** Short facts from supervisor records, most useful first. */
  facts: string[];
}

export interface SpillSection {
  key: SpillSectionKey | "other";
  label: string;
  glyph: string;
  entries: SpillEntry[];
}

export interface SpillSnapshot {
  /** Every section in display order, including empty ones. */
  sections: SpillSection[];
  /** Open tasks per state that exist but were not in the fetched page. */
  unlisted: Partial<Record<TaskState, number>>;
  /** The page was full and the supervisor's counts were unavailable: more may exist. */
  maybeMore: boolean;
  paused: boolean;
}

export interface SpillInput {
  /** Open tasks (anything not completed or cancelled). */
  tasks: Task[];
  /** Open attention requests. */
  attention: Attention[];
  /** Task events by task id, oldest first; tasks without an entry show no milestone. */
  events?: Record<string, TaskEvent[]>;
  /** The supervisor's task counts per state, to detect a truncated page. */
  counts?: Partial<Record<TaskState, number>> | null;
  /** The page size used to fetch `tasks`. */
  pageLimit?: number;
  paused?: boolean;
  now: number;
}

/** Most open tasks the supervisor returns in one request. */
export const SPILL_PAGE_LIMIT = 200;
/** No activity for this long reads as quiet (matches the sidebar). */
const QUIET_MS = 10 * 60_000;
const TITLE_MAX = 80;
const FACT_MAX = 90;
const REASON_MAX = 70;

/** Attention kinds that stop work until someone answers. */
const BLOCKING: ReadonlySet<AttentionKind> = new Set([
  "permission",
  "question",
  "decision",
  "ambiguous_launch",
  "land",
]);

const ATTENTION_LABEL: Record<AttentionKind, string> = {
  permission: "permission",
  question: "question",
  decision: "decision",
  failure: "failure",
  stall: "stalled",
  review: "review",
  ambiguous_launch: "unclear launch",
  land: "confirm landing",
};

/**
 * Supervisor events worth calling a milestone, by type. Only the type and time
 * are shown, never event data (which can carry notes or error text). If tasks
 * gain a recorded progress field, show it next to (or instead of) this.
 */
const MILESTONES: Partial<Record<TaskEventType, string>> = {
  "workspace.ready": "worktree ready",
  "session.created": "worker session started",
  "prompt.intent": "instructions sent",
  "worker.steered": "follow-up sent",
  "interaction.pending": "request raised",
  "attention.resolved": "request answered",
  "attention.expired": "request expired",
  "permission.yolo_approved": "permission auto-approved",
  "quota.limited": "hit a usage limit",
  "launch.deferred": "launch deferred",
  "task.resumed": "resumed",
  "task.taken_over": "taken over",
  "task.given_back": "handed back",
  "pull_request.opened": "pull request opened",
  "pull_request.failed": "pull request failed",
  "review.changes_requested": "changes requested",
  "land.requested": "push confirmation requested",
  "land.failed": "landing failed",
  "task.landed": "landed",
};

/** "<1m", "4m", "2h", "3d". */
function ago(iso: string | null, now: number): string {
  if (!iso) return "?";
  const ms = Math.max(0, now - Date.parse(iso));
  if (Number.isNaN(ms)) return "?";
  if (ms < 60_000) return "<1m";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

const ESC = String.fromCharCode(0x1b);
/** Terminal escape sequences (colors, cursor movement) in untrusted text. */
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-_]`, "g");

/** Control characters, zero-width characters and bidirectional overrides that could hide or reorder text. */
function unsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** One line of display text: secrets redacted, escapes and control characters removed, bounded. */
export function sanitizeLine(text: string, max: number): string {
  const clean = redact(text)
    .replace(ANSI, "")
    .replace(/./gsu, (c) => (unsafe(c.codePointAt(0)!) ? " " : c))
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

function latestMilestone(events: TaskEvent[] | undefined, now: number): string | null {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const event = events![i]!;
    const label = MILESTONES[event.type];
    if (label) return `latest: ${label} ${since(event.createdAt, now)}`;
  }
  return null;
}

/** "just now" or "4m ago". */
function since(iso: string, now: number): string {
  const when = ago(iso, now);
  return when === "<1m" ? "just now" : `${when} ago`;
}

function activity(t: Task, now: number): string {
  if (!t.lastActivityAt) return "no activity recorded";
  const quiet = now - Date.parse(t.lastActivityAt) > QUIET_MS;
  return quiet ? `quiet ${ago(t.lastActivityAt, now)}` : `active ${since(t.lastActivityAt, now)}`;
}

function waitingOn(a: Attention, now: number): string {
  const who = a.resolvableBy === "human" ? "you" : "the manager";
  const reason = sanitizeLine(a.reason, REASON_MAX);
  return `waits on ${who}: ${ATTENTION_LABEL[a.kind]}, ${since(a.createdAt, now)}${reason ? ` “${reason}”` : ""}`;
}

function facts(t: Task, section: SpillSectionKey, attention: Attention[], input: SpillInput) {
  const { now } = input;
  const out: string[] = [];
  const blocking = attention.filter((a) => BLOCKING.has(a.kind));
  switch (section) {
    case "running":
      out.push(`running ${ago(t.startedAt ?? t.createdAt, now)}`, activity(t, now));
      break;
    case "waiting":
      out.push(...blocking.map((a) => waitingOn(a, now)));
      if (!blocking.length) out.push(`blocked ${ago(t.updatedAt, now)}, no open request recorded`);
      break;
    case "manual":
      out.push(`you drive it, ${ago(t.updatedAt, now)}`);
      break;
    case "stuck":
      out.push(`${t.state.replaceAll("_", " ")} ${ago(t.finishedAt ?? t.updatedAt, now)}`);
      if (t.error) out.push(`error: ${sanitizeLine(t.error, REASON_MAX)}`);
      break;
    case "queued":
      out.push(
        t.state === "starting"
          ? `starting ${ago(t.updatedAt, now)}`
          : `queued ${ago(t.createdAt, now)}`,
      );
      if (t.dependsOn.length) {
        const shown = t.dependsOn.slice(0, 2).join(", ");
        const more = t.dependsOn.length > 2 ? ` +${t.dependsOn.length - 2}` : "";
        out.push(`after ${shown}${more}`);
      }
      break;
    case "review": {
      out.push(`ready ${ago(t.finishedAt ?? t.updatedAt, now)}`);
      const v = t.result?.verification;
      if (v) {
        out.push(
          `${v.changedFiles.length} file${v.changedFiles.length === 1 ? "" : "s"}, ${v.commitsAhead} commit${v.commitsAhead === 1 ? "" : "s"}${v.dirty ? ", uncommitted changes" : ""}`,
        );
      }
      if (t.result && !t.result.reported) out.push("no valid report");
      if (t.pullRequestUrl) out.push("PR open");
      break;
    }
  }
  if (t.attempts > 1) out.push(`attempt ${t.attempts}`);
  if (section !== "waiting" && attention.some((a) => a.kind === "stall"))
    out.push("flagged stalled");
  if (section === "running" || section === "waiting" || section === "manual") {
    const milestone = latestMilestone(input.events?.[t.id], now);
    if (milestone) out.push(milestone);
  }
  return out.map((f) => truncate(f, FACT_MAX));
}

function sectionOf(t: Task, blocked: boolean): SpillSectionKey {
  if (blocked || t.state === "blocked") return "waiting";
  switch (t.state) {
    case "running":
      return "running";
    case "manual":
      return "manual";
    case "ready_for_review":
      return "review";
    case "queued":
    case "starting":
      return "queued";
    default:
      return "stuck";
  }
}

const SECTIONS: { key: SpillSectionKey; label: string; glyph: string }[] = [
  { key: "running", label: "Running", glyph: "●" },
  { key: "waiting", label: "Blocked / waiting", glyph: "!" },
  { key: "manual", label: "Manual (you)", glyph: "◆" },
  { key: "stuck", label: "Stuck", glyph: "✗" },
  { key: "queued", label: "Queued / starting", glyph: "·" },
  { key: "review", label: "Ready for review", glyph: "✓" },
];

/** Groups open work into sections, each task exactly once, in a stable order. */
export function buildSpill(input: SpillInput): SpillSnapshot {
  const tasks = input.tasks.filter((t) => OPEN_STATES.has(t.state));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = input.attention.filter((a) => a.status === "open");
  const attentionOf = new Map<string, Attention[]>();
  for (const a of open.toSorted((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    if (a.taskId && byId.has(a.taskId)) {
      attentionOf.set(a.taskId, [...(attentionOf.get(a.taskId) ?? []), a]);
    }
  }

  const grouped = new Map<SpillSectionKey, Task[]>(SECTIONS.map((s) => [s.key, []]));
  for (const t of tasks) {
    const blocked = (attentionOf.get(t.id) ?? []).some((a) => BLOCKING.has(a.kind));
    grouped.get(sectionOf(t, blocked))!.push(t);
  }
  // Oldest first, so a long-running task does not move around between calls.
  const start = (t: Task) => t.startedAt ?? t.createdAt;
  const sections: SpillSection[] = SECTIONS.map((s) => ({
    ...s,
    entries: grouped
      .get(s.key)!
      .toSorted((a, b) => start(a).localeCompare(start(b)) || a.id.localeCompare(b.id))
      .map((t) => ({
        ref: t.id,
        title: sanitizeLine(t.title, TITLE_MAX) || "(untitled)",
        repo: sanitizeLine(t.repo, 40),
        state: t.state,
        facts: facts(t, s.key, attentionOf.get(t.id) ?? [], input),
      })),
  }));

  // Attention not tied to listed work (e.g. an invalid ocd.jsonc) is still shown.
  const other = open
    .filter((a) => !a.taskId || !byId.has(a.taskId))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((a) => ({
      ref: a.id,
      title: sanitizeLine(a.reason, TITLE_MAX) || ATTENTION_LABEL[a.kind],
      repo: a.repo ? sanitizeLine(a.repo, 40) : null,
      state: null,
      facts: [
        `${ATTENTION_LABEL[a.kind]} for ${a.resolvableBy === "human" ? "you" : "the manager"}, ${since(a.createdAt, input.now)}${a.taskId ? ` · task ${a.taskId}` : ""}`,
      ],
    }));
  sections.push({ key: "other", label: "Other attention", glyph: "!", entries: other });

  const limit = input.pageLimit ?? SPILL_PAGE_LIMIT;
  const full = input.tasks.length >= limit;
  const unlisted: Partial<Record<TaskState, number>> = {};
  if (full && input.counts) {
    for (const state of OPEN_STATES) {
      const missing = (input.counts[state] ?? 0) - tasks.filter((t) => t.state === state).length;
      if (missing > 0) unlisted[state] = missing;
    }
  }
  return {
    sections,
    unlisted,
    maybeMore: full && !input.counts,
    paused: input.paused ?? false,
  };
}

export interface SpillFormatOptions {
  /** Entries shown per section; the rest are counted with `continuation`. Default: all. */
  maxPerSection?: number;
  /** Where to see the rest, e.g. "ocd spill". */
  continuation?: string;
}

/** Plain text: a count overview, then one short entry per task in each non-empty section. */
export function formatSpill(snapshot: SpillSnapshot, options: SpillFormatOptions = {}): string {
  const count = (key: SpillSection["key"]) =>
    snapshot.sections.find((s) => s.key === key)?.entries.length ?? 0;
  const parts = [
    `${count("running")} running`,
    ...(
      [
        ["waiting", "blocked/waiting"],
        ["manual", "manual"],
        ["stuck", "stuck"],
        ["queued", "queued/starting"],
        ["review", "ready for review"],
        ["other", "other attention"],
      ] as const
    ).flatMap(([key, label]) => (count(key) ? [`${count(key)} ${label}`] : [])),
  ];
  const lines = [`OCD · ${parts.join(" · ")}${snapshot.paused ? " · dispatch paused" : ""}`];

  const unlisted = Object.entries(snapshot.unlisted).map(
    ([s, n]) => `${n} ${s.replaceAll("_", " ")}`,
  );
  const empty = snapshot.sections.every((s) => s.entries.length === 0);
  if (empty && !unlisted.length && !snapshot.maybeMore) {
    lines.push("", "Nothing running, queued, blocked or waiting for review.");
    return lines.join("\n");
  }

  const max = options.maxPerSection ?? Infinity;
  for (const section of snapshot.sections) {
    if (!section.entries.length) continue;
    lines.push("", `${section.label} (${section.entries.length})`);
    for (const e of section.entries.slice(0, max)) {
      lines.push(`  ${section.glyph} ${e.title}`);
      lines.push(`    ${[...(e.repo ? [e.repo] : []), ...e.facts, e.ref].join(" · ")}`);
    }
    const hidden = section.entries.length - Math.min(max, section.entries.length);
    if (hidden > 0) {
      lines.push(
        `  +${hidden} more ${section.label.toLowerCase()}${options.continuation ? `: ${options.continuation}` : ""}`,
      );
    }
  }
  if (unlisted.length) {
    lines.push(
      "",
      `Not shown (over ${SPILL_PAGE_LIMIT} open tasks): ${unlisted.join(", ")}. See ocd task list --all.`,
    );
  } else if (snapshot.maybeMore) {
    lines.push(
      "",
      `More than ${SPILL_PAGE_LIMIT} open tasks; some may not be shown. See ocd task list.`,
    );
  }
  return lines.join("\n");
}

/** States whose latest supervisor event is worth fetching as a milestone. */
const MILESTONE_STATES: ReadonlySet<TaskState> = new Set(["running", "blocked", "manual"]);
const INSPECT_CONCURRENCY = 6;

/**
 * Reads everything `/spill` shows. Read-only: list and inspect calls only.
 * Fails if tasks or attention cannot be read, rather than showing a partial
 * picture; a task whose events cannot be read just has no milestone.
 */
export async function collectSpill(client: OcdClient, now = Date.now()): Promise<SpillInput> {
  const [tasks, attention, status] = await Promise.all([
    client.listTasks({ open: true, limit: SPILL_PAGE_LIMIT }),
    client.listAttention({ status: "open", limit: 200 }),
    client.status().catch(() => null),
  ]);
  const live = tasks.filter((t) => MILESTONE_STATES.has(t.state));
  const events: Record<string, TaskEvent[]> = {};
  for (let i = 0; i < live.length; i += INSPECT_CONCURRENCY) {
    await Promise.all(
      live.slice(i, i + INSPECT_CONCURRENCY).map(async (t) => {
        try {
          events[t.id] = (await client.inspectTask(t.id)).events;
        } catch {
          // No milestone for this task; it is still listed.
        }
      }),
    );
  }
  return {
    tasks,
    attention,
    events,
    counts: status?.counts ?? null,
    pageLimit: SPILL_PAGE_LIMIT,
    paused: status?.paused ?? false,
    now,
  };
}
