import { describe, expect, it } from "vite-plus/test";

import {
  buildSpill,
  formatSpill,
  sanitizeLine,
  SPILL_PAGE_LIMIT,
  type Attention,
  type SpillInput,
  type Task,
  type TaskEvent,
  type TaskEventType,
} from "./index.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  const id = over.id ?? `t_${String(seq).padStart(14, "0")}`;
  return {
    id,
    idempotencyKey: `key-${id}`,
    repo: "app",
    profile: {
      name: "fake",
      harness: "fake",
      model: "fake/model",
      description: null,
      agent: null,
      instructions: null,
      permissionPolicy: "ask",
      envAllowlist: [],
    },
    harness: "fake",
    model: "fake/model",
    title: `Task ${seq}`,
    instructions: "SECRET INSTRUCTIONS that must never be shown",
    acceptanceCriteria: [],
    state: "running",
    workspaceMode: "isolated",
    workspacePath: null,
    branch: null,
    baseRef: null,
    sessionId: null,
    pullRequestUrl: null,
    attempts: 1,
    result: null,
    error: null,
    dependsOn: [],
    lastActivityAt: at(1),
    createdAt: at(30),
    updatedAt: at(1),
    startedAt: at(20),
    finishedAt: null,
    branchSync: null,
    ...over,
  };
}

function attention(over: Partial<Attention> & Pick<Attention, "kind">): Attention {
  seq += 1;
  return {
    id: `a_${seq}`,
    taskId: null,
    repo: null,
    status: "open",
    reason: "Needs a look",
    operation: null,
    harness: null,
    sessionId: null,
    requestRef: null,
    resolvableBy: "human",
    expiresAt: null,
    response: null,
    resolvedBy: null,
    createdAt: at(5),
    resolvedAt: null,
    ...over,
  };
}

function event(
  taskId: string,
  type: TaskEventType,
  minutesAgo: number,
  data: unknown = {},
): TaskEvent {
  seq += 1;
  return { id: seq, taskId, type, data, createdAt: at(minutesAgo) };
}

const spill = (input: Partial<SpillInput>, max?: number) =>
  formatSpill(
    buildSpill({ tasks: [], attention: [], now: NOW, ...input }),
    max === undefined ? {} : { maxPerSection: max, continuation: "ocd spill" },
  );

describe("/spill snapshot", () => {
  it("has a clear empty state", () => {
    expect(spill({})).toBe(
      "OCD · 0 running\n\nNothing running, queued, blocked or waiting for review.",
    );
    expect(spill({ paused: true })).toMatch(/^OCD · 0 running · dispatch paused\n/);
  });

  it("shows a pending push confirmation and the landing milestones", () => {
    const review = task({
      id: "t_l",
      title: "Landing",
      state: "ready_for_review",
      finishedAt: at(9),
    });
    const out = spill({
      tasks: [review],
      attention: [attention({ kind: "land", taskId: "t_l", reason: "Push to main" })],
      events: { t_l: [event("t_l", "land.requested", 3)] },
    });
    expect(out).toMatch(/confirm landing/);
    expect(out).toMatch(/Blocked \/ waiting/);
    const again = spill({
      tasks: [task({ id: "t_r2", title: "Reworked" })],
      events: { t_r2: [event("t_r2", "review.changes_requested", 1)] },
    });
    expect(again).toMatch(/latest: changes requested/);
  });

  it("separates running, blocked, manual, stuck, queued and review work across repos", () => {
    const running = task({ id: "t_run", title: "Add /spill", repo: "ocd" });
    const blocked = task({ id: "t_blk", title: "Fix login", repo: "web", state: "blocked" });
    // Still `running`, but a human-only question stops it: listed as waiting, once.
    const asking = task({ id: "t_ask", title: "Pick an approach", repo: "api" });
    const manual = task({ id: "t_man", title: "Hand-driven", state: "manual", updatedAt: at(12) });
    const failed = task({ id: "t_bad", title: "Broke", state: "failed", error: "Exit 1" });
    const queued = task({
      id: "t_q",
      title: "Later",
      state: "queued",
      startedAt: null,
      lastActivityAt: null,
      dependsOn: ["t_run"],
    });
    const starting = task({ id: "t_st", title: "Booting", state: "starting", startedAt: null });
    const review = task({
      id: "t_rev",
      title: "Done thing",
      state: "ready_for_review",
      finishedAt: at(60),
      result: {
        reported: { summary: "worker claims", changedFiles: [], tests: [], unresolved: [] },
        reportError: null,
        verification: { changedFiles: ["a.ts", "b.ts"], dirty: false, commitsAhead: 1 },
        finalMessageExcerpt: "raw transcript excerpt",
      },
    });
    const text = spill({
      tasks: [review, starting, queued, failed, manual, asking, blocked, running],
      attention: [
        attention({ kind: "permission", taskId: "t_blk", reason: "Run `rm -rf build`" }),
        attention({
          kind: "question",
          taskId: "t_ask",
          resolvableBy: "manager",
          reason: "A or B?",
        }),
        attention({ kind: "failure", taskId: "t_bad", reason: "Worker failed" }),
      ],
    });
    expect(text).toBe(
      [
        "OCD · 1 running · 2 blocked/waiting · 1 manual · 1 stuck · 2 queued/starting · 1 ready for review",
        "",
        "Running (1)",
        "  ● Add /spill",
        "    ocd · running 20m · active 1m ago · t_run",
        "",
        "Blocked / waiting (2)",
        "  ! Pick an approach",
        "    api · waits on the manager: question, 5m ago “A or B?” · t_ask",
        "  ! Fix login",
        "    web · waits on you: permission, 5m ago “Run `rm -rf build`” · t_blk",
        "",
        "Manual (you) (1)",
        "  ◆ Hand-driven",
        "    app · you drive it, 12m · t_man",
        "",
        "Stuck (1)",
        "  ✗ Broke",
        "    app · failed 1m · error: Exit 1 · t_bad",
        "",
        "Queued / starting (2)",
        "  · Later",
        "    app · queued 30m · after t_run · t_q",
        "  · Booting",
        "    app · starting 1m · t_st",
        "",
        "Ready for review (1)",
        "  ✓ Done thing",
        "    app · ready 1h · 2 files, 1 commit · t_rev",
      ].join("\n"),
    );
    // Worker claims, instructions and transcript excerpts are never shown.
    expect(text).not.toMatch(/worker claims|SECRET INSTRUCTIONS|raw transcript/);
  });

  it("excludes completed and cancelled history", () => {
    const text = spill({
      tasks: [
        task({ id: "t_live" }),
        task({ id: "t_done", state: "completed" }),
        task({ id: "t_gone", state: "cancelled" }),
      ],
    });
    expect(text).toMatch(/^OCD · 1 running$/m);
    expect(text).not.toMatch(/t_done|t_gone/);
  });

  it("shows only recorded facts when progress is missing", () => {
    const text = spill({
      tasks: [task({ id: "t_new", startedAt: null, lastActivityAt: null, createdAt: at(3) })],
      events: {},
    });
    expect(text).toContain("app · running 3m · no activity recorded · t_new");
    expect(text).not.toContain("latest:");
  });

  it("reports the latest meaningful supervisor milestone, never event data", () => {
    const t = task({ id: "t_ev", lastActivityAt: at(15), attempts: 2 });
    const text = spill({
      tasks: [t],
      events: {
        t_ev: [
          event("t_ev", "workspace.ready", 20),
          event("t_ev", "worker.steered", 8, { note: "private note" }),
          event("t_ev", "state.running", 7),
          event("t_ev", "some.unknown" as TaskEventType, 6, { text: "leak" }),
        ],
      },
    });
    expect(text).toContain(
      "app · running 20m · quiet 15m · attempt 2 · latest: follow-up sent 8m ago · t_ev",
    );
    expect(text).not.toMatch(/private note|leak|some\.unknown/);
  });

  it("sanitizes and bounds malformed or long titles and reasons", () => {
    // Written as code points so the source stays plain ASCII.
    const [ESC, RLO, ZWSP, NUL] = [0x1b, 0x202e, 0x200b, 0].map((c) => String.fromCharCode(c));
    const evil = task({
      id: "t_evil",
      title: `${ESC}[31mred${ESC}[0m\nline two${RLO} reversed token=supersecretvalue ${"x".repeat(500)}`,
    });
    const blank = task({ id: "t_blank", title: " \n\t " });
    const text = spill({
      tasks: [evil, blank],
      attention: [attention({ kind: "decision", reason: `ghp_${"a".repeat(30)}\r\nsecond` })],
    });
    for (const bad of [ESC, RLO, "\r", "supersecretvalue", "ghp_a"]) {
      expect(text).not.toContain(bad);
    }
    const titleLine = text.split("\n").find((l) => l.includes("red line two"))!;
    expect(titleLine.length).toBeLessThanOrEqual(84);
    expect(titleLine.endsWith("…")).toBe(true);
    expect(text).toContain("(untitled)");
    expect(text).toContain("Other attention (1)");
    expect(text).toContain("[REDACTED] second");
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(300);
    expect(sanitizeLine(`a${NUL}b${ZWSP}c`, 10)).toBe("a b c");
  });

  it("represents every task, with an explicit continuation when a section is capped", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      task({ id: `t_many${String(i).padStart(2, "0")}`, repo: i % 2 ? "web" : "api" }),
    );
    const full = spill({ tasks: many });
    for (const t of many) expect(full).toContain(t.id);
    expect(full).toMatch(/^OCD · 25 running$/m);

    const capped = spill({ tasks: many }, 8);
    expect(capped.match(/^ {2}● /gm)).toHaveLength(8);
    expect(capped).toContain("  +17 more running: ocd spill");
  });

  it("is deterministic regardless of input order", () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      task({ id: `t_d${i}`, startedAt: at(10), state: i % 2 ? "running" : "queued" }),
    );
    const a = spill({ tasks });
    expect(spill({ tasks: tasks.toReversed() })).toBe(a);
    expect(a.indexOf("t_d1")).toBeLessThan(a.indexOf("t_d3"));
  });

  it("says which open tasks did not fit in one page", () => {
    const page = Array.from({ length: SPILL_PAGE_LIMIT }, (_, i) =>
      task({ id: `t_p${i}`, state: "queued" }),
    );
    const text = spill({ tasks: page, counts: { queued: 203, running: 1, completed: 40 } });
    expect(text).toContain(
      `Not shown (over ${SPILL_PAGE_LIMIT} open tasks): 3 queued, 1 running. See ocd task list --all.`,
    );
    expect(spill({ tasks: page, counts: null })).toMatch(/some may not be shown/);
    // A page that was not full lists everything; racing counts are ignored.
    expect(spill({ tasks: page.slice(0, 5), counts: { queued: 9 } })).not.toMatch(/Not shown/);
  });
});
