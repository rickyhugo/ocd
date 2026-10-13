import type { Attention, Task } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { actionsFor, age, buildSidebar } from "./sidebar-model.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function task(id: string, state: Task["state"], extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: "dotfiles",
    state,
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(5),
    startedAt: minutesAgo(30),
    finishedAt: null,
    lastActivityAt: minutesAgo(1),
    ...extra,
  } as Task;
}

function attention(
  id: string,
  taskId: string | null,
  kind: Attention["kind"],
  extra: Partial<Attention> = {},
): Attention {
  return {
    id,
    taskId,
    kind,
    status: "open",
    reason: `reason ${id}`,
    resolvableBy: "human",
    createdAt: minutesAgo(2),
    ...extra,
  } as Attention;
}

describe("sidebar model", () => {
  it("formats ages compactly", () => {
    expect(age(minutesAgo(0.5), NOW)).toBe("now");
    expect(age(minutesAgo(4), NOW)).toBe("4m");
    expect(age(minutesAgo(125), NOW)).toBe("2h");
    expect(age(minutesAgo(60 * 49), NOW)).toBe("2d");
    expect(age(null, NOW)).toBe("");
  });

  it("puts what needs the human first and leaves out empty sections", () => {
    const tasks = [
      task("a", "running"),
      task("b", "blocked"),
      task("c", "ready_for_review", { finishedAt: minutesAgo(3) }),
      task("d", "queued"),
    ];
    const model = buildSidebar(
      tasks,
      [
        attention("x", "b", "permission"),
        attention("y", "a", "stall", { resolvableBy: "manager" }),
      ],
      NOW,
    );
    expect(model.sections.map((s) => s.key)).toEqual(["needs", "review", "running", "queued"]);
    expect(model.urgent.map((r) => [r.title, r.meta])).toEqual([["Task b", "permission"]]);
    // A task waiting on the human is listed once, under "Needs you".
    expect(model.sections.find((s) => s.key === "running")?.rows.map((r) => r.key)).toEqual(["a"]);
    expect(model.sections.find((s) => s.key === "review")?.rows[0]?.meta).toBe("3m");
    expect(model.counts.map((c) => `${c.glyph}${c.count}`)).toEqual(["!1", "✓1", "●1", "·1"]);
    expect(model.idle).toBe(false);
  });

  it("keeps review items with their task instead of under Needs you", () => {
    const model = buildSidebar(
      [task("c", "ready_for_review")],
      [
        attention("r", "c", "review"),
        attention("d", null, "failure", { reason: "outbox gave up" }),
      ],
      NOW,
    );
    expect(model.sections.map((s) => [s.key, s.rows.map((r) => r.title)])).toEqual([
      ["needs", ["outbox gave up"]],
      ["review", ["Task c"]],
    ]);
  });

  it("marks running tasks without recent activity as quiet", () => {
    const model = buildSidebar([task("a", "running", { lastActivityAt: minutesAgo(25) })], [], NOW);
    expect(model.sections[0]?.rows[0]).toMatchObject({ meta: "quiet 25m", tone: "muted" });
  });

  it("collapses long background sections by default and says idle when empty", () => {
    const many = Array.from({ length: 6 }, (_, i) => task(`r${i}`, "running"));
    expect(buildSidebar(many, [], NOW).sections[0]?.openByDefault).toBe(false);
    expect(buildSidebar([], [], NOW)).toMatchObject({ sections: [], counts: [], idle: true });
  });

  it("shows recently finished work: inline when idle, as a closed section otherwise", () => {
    const done = [
      task("f", "completed", { finishedAt: minutesAgo(90), workspacePath: "/ws/f" }),
      task("g", "cancelled", { finishedAt: minutesAgo(30), workspacePath: null }),
      task("old", "completed", { finishedAt: minutesAgo(60 * 30) }),
    ];
    const idle = buildSidebar([], [], NOW, done);
    expect(idle.idle).toBe(true);
    expect(idle.sections).toEqual([]);
    expect(idle.recent.map((r) => [r.key, r.glyph, r.meta])).toEqual([
      ["g", "–", "30m"],
      ["f", "✓", "kept · 1h"],
    ]);
    const busy = buildSidebar([task("a", "running")], [], NOW, done);
    expect(busy.sections.map((s) => [s.key, s.openByDefault])).toEqual([
      ["running", true],
      ["recent", false],
    ]);
  });

  it("offers accept and clean up for review, and clean up for kept worktrees", () => {
    const [review] = buildSidebar([task("c", "ready_for_review")], [], NOW).sections[0]!.rows;
    expect(actionsFor(review!).slice(0, 2)).toEqual([
      { label: "Accept and clean up", kind: "accept_clean" },
      { label: "Accept (keep the worktree)", kind: "accept" },
    ]);
    const [kept, gone] = buildSidebar([], [], NOW, [
      task("f", "completed", { finishedAt: minutesAgo(5), workspacePath: "/ws/f" }),
      task("g", "completed", { finishedAt: minutesAgo(5), workspacePath: null }),
    ]).recent;
    expect(actionsFor(kept!).map((a) => a.label)).toContain("Clean up the worktree");
    expect(actionsFor(gone!).map((a) => a.label)).not.toContain("Clean up the worktree");
  });

  it("lists manual tasks right after Needs you, with take-over and give-back actions", () => {
    const model = buildSidebar(
      [
        task("m", "manual", { sessionId: "s-m", updatedAt: minutesAgo(12) }),
        task("r", "running", { sessionId: "s-r" }),
        task("q", "queued", { sessionId: null }),
      ],
      [],
      NOW,
    );
    expect(model.sections.map((s) => s.key)).toEqual(["manual", "running", "queued"]);
    const [manual] = model.sections[0]!.rows;
    expect(manual).toMatchObject({ glyph: "◆", meta: "you · 12m" });
    expect(actionsFor(manual!).map((a) => a.label)).toEqual([
      "Open the session",
      "Give back: let the worker continue",
      "Give back: ready for review",
      "Message the manager about it…",
      "Details",
    ]);
    const running = model.sections[1]!.rows[0]!;
    expect(actionsFor(running).map((a) => a.label)).toContain("Take over (manual mode)");
    const queued = model.sections[2]!.rows[0]!;
    expect(actionsFor(queued).map((a) => a.label)).not.toContain("Take over (manual mode)");
  });

  it("offers actions that fit the task's state", () => {
    const [review] = buildSidebar([task("c", "ready_for_review")], [], NOW).sections[0]!.rows;
    expect(actionsFor(review!).map((a) => a.label)).toContain("Accept and open a PR");
    const [running] = buildSidebar([task("a", "running")], [], NOW).sections[0]!.rows;
    expect(actionsFor(running!).map((a) => a.label)).toContain("Status update");
  });
});
