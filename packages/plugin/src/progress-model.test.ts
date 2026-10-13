import type { Task, TaskEvent, TaskProgress } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import {
  MILESTONES_MAX,
  PANEL_MAX_HEIGHT,
  canExpand,
  milestone,
  panelHeight,
  panelScrolls,
  progressLines,
  progressTargets,
  pruneExpanded,
  shortPullRequest,
  toggleExpanded,
} from "./progress-model.ts";
import { actionsFor, buildSidebar } from "./sidebar-model.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function task(id: string, state: Task["state"], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: "dotfiles",
    harness: "claude",
    state,
    pullRequestUrl: null,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(5),
    startedAt: minutesAgo(30),
    finishedAt: null,
    lastActivityAt: minutesAgo(1),
    ...extra,
  } as Task;
}

let seq = 0;
const event = (type: string, minutes: number, data: unknown = null): TaskEvent => ({
  id: ++seq,
  taskId: "a",
  type,
  data,
  createdAt: minutesAgo(minutes),
});

function progress(extra: Partial<TaskProgress> = {}): TaskProgress {
  return {
    taskId: "a",
    todosSupported: true,
    todos: null,
    todosUpdatedAt: null,
    events: [],
    ...extra,
  };
}

const text = (lines: { glyph: string; text: string; meta: string }[]) =>
  lines.map((l) => `${l.glyph} ${l.text}${l.meta ? ` ${l.meta}` : ""}`);

describe("progress panel model", () => {
  it("expands only running-task rows, never attention rows or other states", () => {
    const model = buildSidebar(
      [
        task("r", "running"),
        task("s", "starting"),
        task("b", "blocked"),
        task("p", "blocked"),
        task("v", "ready_for_review"),
        task("m", "manual"),
        task("q", "queued"),
      ],
      [
        {
          id: "x",
          taskId: "p",
          kind: "permission",
          status: "open",
          reason: "r",
          resolvableBy: "human",
          createdAt: minutesAgo(1),
        } as never,
      ],
      NOW,
    );
    const expandable = model.sections.flatMap((s) => s.rows.filter(canExpand).map((r) => r.key));
    expect(expandable.toSorted()).toEqual(["b", "r", "s"]);
    // The attention row for "p" keeps its own action menu.
    expect(model.urgent.map(canExpand)).toEqual([false]);
  });

  it("toggles expansion without touching the row's actions", () => {
    const [row] = buildSidebar([task("a", "running", { sessionId: "s" })], [], NOW).sections[0]!
      .rows;
    const before = actionsFor(row!);
    let expanded = toggleExpanded(new Set(), "a");
    expect([...expanded]).toEqual(["a"]);
    expect(actionsFor(row!)).toEqual(before);
    expanded = toggleExpanded(expanded, "a");
    expect(expanded.size).toBe(0);
  });

  it("is collapsed by default and only fetches open, visible panels", () => {
    const rows = buildSidebar([task("a", "running"), task("b", "running")], [], NOW).sections[0]!
      .rows;
    expect(progressTargets(new Set(), rows)).toEqual([]);
    expect(progressTargets(new Set(["b", "gone"]), rows)).toEqual(["b"]);
    // Hidden (sidebar or section closed): nothing is fetched.
    expect(progressTargets(new Set(["b"]), [])).toEqual([]);
  });

  it("keeps expansion through updates and forgets tasks that are no longer open", () => {
    const expanded: ReadonlySet<string> = new Set(["a", "b"]);
    // An ordinary refresh returns the same set, so nothing re-renders.
    expect(pruneExpanded(expanded, ["a", "b", "c"])).toBe(expanded);
    // "b" finished: its expansion is dropped.
    expect([...pruneExpanded(expanded, ["a", "c"])]).toEqual(["a"]);
  });

  it("renders the checklist with its statuses and counts", () => {
    const lines = progressLines(
      task("a", "running"),
      progress({
        todos: [
          { text: "Read the code", status: "completed" },
          { text: "Make the change", status: "in_progress" },
          { text: "Run the tests", status: "pending" },
          { text: "Old idea", status: "cancelled" },
        ],
      }),
      NOW,
    );
    expect(text(lines)).toEqual([
      "☰ Checklist 1/4",
      "✓ Read the code",
      "▸ Make the change",
      "○ Run the tests",
      "– Old idea",
    ]);
    expect(lines[1]?.tone).toBe("success");
    expect(lines[2]?.tone).toBe("accent");
  });

  it("shows a recorded PR first and nothing PR-like otherwise", () => {
    const url = "https://github.com/rickyhugo/ocd/pull/22";
    const withPr = progressLines(task("a", "running", { pullRequestUrl: url }), progress(), NOW);
    expect(text(withPr)[0]).toBe("⇡ PR rickyhugo/ocd#22");
    const without = progressLines(task("a", "running"), progress(), NOW);
    expect(without.some((l) => l.text.startsWith("PR"))).toBe(false);
    expect(shortPullRequest("https://gitlab.example.com/o/r/-/merge_requests/3")).toBe(
      "gitlab.example.com/o/r/-/merge_requests/3",
    );
  });

  it("falls back to milestones when the harness reports no checklist", () => {
    const events = [
      event("task.created", 40),
      event("launch.intent", 30, { runId: "w", attempt: 1 }),
      event("prompt.intent", 30),
      event("state.running", 29, { from: "starting", to: "running" }),
      event("permission.yolo_approved", 20),
      event("attention.raised", 10, { id: "x", kind: "stall" }),
      event("attention.raised", 5, { id: "y", kind: "stall" }),
    ];
    const opencode = progressLines(
      task("a", "running", { harness: "opencode" }),
      progress({ todosSupported: false, events }),
      NOW,
    );
    expect(text(opencode)).toEqual([
      "○ No checklist from opencode",
      // Newest first; noise skipped; repeats collapsed to the latest.
      "· Looks stalled 5m",
      "· Running 29m",
      "· Instructions sent 30m",
      "· Worker launching 30m",
      "· Queued 40m",
    ]);
    const claude = progressLines(task("a", "running"), progress({ events: [] }), NOW);
    expect(text(claude)).toEqual(["○ No checklist reported yet"]);
    expect(text(progressLines(task("a", "running"), progress({ todos: [] }), NOW))).toEqual([
      "○ Checklist is empty",
    ]);
  });

  it("says when progress is loading or unavailable", () => {
    expect(text(progressLines(task("a", "running"), undefined, NOW))).toEqual([
      "… Loading progress",
    ]);
    expect(text(progressLines(task("a", "running"), "unavailable", NOW))).toEqual([
      "○ Progress unavailable",
    ]);
  });

  it("labels lifecycle events and skips unknown ones", () => {
    expect(milestone(event("launch.intent", 1, { attempt: 2 }))).toBe(
      "Worker launching (attempt 2)",
    );
    expect(milestone(event("state.running", 1, { from: "blocked" }))).toBe("Unblocked");
    expect(milestone(event("attention.raised", 1, { kind: "permission" }))).toBe(
      "Asked for permission",
    );
    expect(milestone(event("pull_request.opened", 1))).toBe("PR opened");
    expect(milestone(event("something.new", 1))).toBeNull();
  });

  it("bounds milestones and panel height; only overflowing panels scroll", () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      event(i % 2 ? "worker.steered" : "attention.resolved", 30 - i),
    );
    const lines = progressLines(task("a", "running"), progress({ events }), NOW);
    expect(lines.filter((l) => l.glyph === "·")).toHaveLength(MILESTONES_MAX);

    const short = progressLines(task("a", "running"), progress(), NOW);
    expect(panelHeight(short)).toBe(1);
    expect(panelScrolls(short)).toBe(false);
    const long = progressLines(
      task("a", "running"),
      progress({
        todos: Array.from({ length: 20 }, (_, i) => ({ text: `step ${i}`, status: "pending" })),
      }),
      NOW,
    );
    expect(panelHeight(long)).toBe(PANEL_MAX_HEIGHT);
    expect(panelScrolls(long)).toBe(true);
  });

  it("updates in place as the checklist advances", () => {
    const at = (done: number) =>
      progressLines(
        task("a", "running"),
        progress({
          todos: ["one", "two", "three"].map((t, i) => ({
            text: t,
            status: i < done ? "completed" : i === done ? "in_progress" : "pending",
          })),
        }),
        NOW,
      );
    const [first, second] = [at(0), at(1)];
    // Same number of lines at the same positions: the panel's rows update in place.
    expect(second).toHaveLength(first.length);
    expect(text(second)).toEqual(["☰ Checklist 1/3", "✓ one", "▸ two", "○ three"]);
  });
});
