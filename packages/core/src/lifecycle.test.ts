import { describe, expect, it } from "vite-plus/test";

import {
  STALE_AFTER_MS,
  formatDuration,
  lifecycleLines,
  liveness,
  milestone,
  stageTimings,
  taskLifecycle,
  type Task,
  type TaskEvent,
  type TaskEventType,
  type TaskLifecycle,
  type TaskState,
  type TaskView,
} from "./index.ts";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

let seq = 0;
const ev = (type: TaskEventType, s: number, data: unknown = null): TaskEvent => ({
  id: ++seq,
  taskId: "t",
  type,
  data,
  createdAt: at(s),
});
const move = (from: TaskState, to: TaskState, s: number, type: TaskEventType = `state.${to}`) =>
  ev(type, s, { from, to });

/** The supervisor's launch protocol, prompted at s+10 and running at s+20. */
const launch = (s: number, attempt = 1): TaskEvent[] => [
  move("queued", "starting", s),
  ev("launch.intent", s, { runId: `w${attempt}`, attempt }),
  ev("workspace.ready", s + 5),
  ev("session.created", s + 8),
  ev("prompt.intent", s + 10),
  move("starting", "running", s + 20),
];

function task(state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id: "t",
    state,
    createdAt: at(0),
    updatedAt: at(0),
    lastActivityAt: null,
    ...extra,
  } as Task;
}

const view = (t: Task, events: TaskEvent[]): TaskView => ({
  ...t,
  lifecycle: taskLifecycle(t, events),
});
const stages = (lc: TaskLifecycle) => lc.spans.map((s) => `${s.stage}@${s.attempt}`);

describe("task lifecycle", () => {
  it("walks a first launch through review to done, with a timing per stage", () => {
    const events = [
      ev("task.created", 0),
      ...launch(3),
      ev("worker.responded", 30, { runId: "w1" }),
      ev("pull_request.opened", 600),
      move("running", "ready_for_review", 700),
      move("ready_for_review", "completed", 900, "task.accepted"),
    ];
    const lc = taskLifecycle(task("completed"), events);
    expect(stages(lc)).toEqual([
      "queued@0",
      "preparing_workspace@1",
      "starting_worker@1",
      "working@1",
      "review@1",
      "done@1",
    ]);
    expect(lc).toMatchObject({ stage: "done", since: at(900), attempt: 1, lastEventAt: at(900) });
    expect(lc.spans.at(-1)).toMatchObject({ from: at(900), to: at(900) });
    expect(lc.lastMilestone).toEqual({ label: "Accepted", at: at(900) });
    expect(stageTimings(lc, T0 + 5_000_000)).toEqual({
      queued: 3000,
      preparing_workspace: 5000,
      starting_worker: 22_000,
      working: 670_000,
      review: 200_000,
    });
  });

  it("counts the open stage up to now", () => {
    const events = [ev("task.created", 0), ...launch(3), ev("worker.responded", 30)];
    const lc = taskLifecycle(task("running"), events);
    expect(lc).toMatchObject({ stage: "working", since: at(30) });
    expect(lc.spans.at(-1)?.to).toBeNull();
    expect(stageTimings(lc, T0 + 90_000).working).toBe(60_000);
  });

  it("starts a new attempt on relaunch and when a deferred launch starts again", () => {
    const events = [
      ...launch(0),
      ev("worker.responded", 25),
      move("running", "failed", 100),
      move("failed", "queued", 200, "task.resumed"),
      move("queued", "starting", 210),
      move("starting", "queued", 215, "launch.deferred"),
      ...launch(300, 3),
    ];
    const lc = taskLifecycle(task("running"), events);
    expect(stages(lc)).toEqual([
      "queued@0",
      "preparing_workspace@1",
      "starting_worker@1",
      "working@1",
      "stopped@1",
      "queued@1",
      "preparing_workspace@2",
      "queued@2",
      "preparing_workspace@3",
      "starting_worker@3",
    ]);
    expect(lc.attempt).toBe(3);
  });

  it("keeps working through blocked, a follow-up from review, and a reattach", () => {
    const events = [
      ...launch(0),
      ev("worker.responded", 25),
      move("running", "blocked", 40),
      move("blocked", "running", 50),
      move("running", "ready_for_review", 60),
      move("ready_for_review", "running", 70, "worker.steered"),
      move("running", "interrupted", 80, "shutdown.interrupted"),
      move("interrupted", "running", 90, "task.resumed"),
    ];
    const lc = taskLifecycle(task("running"), events);
    expect(stages(lc).slice(3)).toEqual([
      "working@1",
      "blocked@1",
      "working@1",
      "review@1",
      "working@1",
      "stopped@1",
      "working@1",
    ]);
  });

  it("waits on the worker until it responds, once per launch", () => {
    const legacy = taskLifecycle(task("running"), launch(0));
    expect(legacy.stage).toBe("starting_worker");

    const twice = [...launch(0), ev("worker.responded", 25), ev("worker.responded", 26)];
    expect(stages(taskLifecycle(task("running"), twice))).toEqual(
      stages(taskLifecycle(task("running"), twice.slice(0, -1))),
    );

    // A response while the prompt is still being sent: running goes straight to working.
    const early = [...launch(0).slice(0, -1), ev("worker.responded", 12), launch(0).at(-1)!];
    expect(stages(taskLifecycle(task("running"), early)).at(-1)).toBe("working@1");
  });

  it("follows the task's state when the history does not reach it", () => {
    const lc = taskLifecycle(task("ready_for_review", { updatedAt: at(50) }), []);
    expect(stages(lc)).toEqual(["queued@0", "review@0"]);
    expect(lc).toMatchObject({ stage: "review", since: at(50), lastMilestone: null });
    expect(lc.lastEventAt).toBeNull();
  });
});

describe("liveness", () => {
  const running = (lastActivityAt: string | null) =>
    view(task("running", { lastActivityAt }), [...launch(0), ev("worker.responded", 25)]);

  it("is live while the worker signals and stale after a quiet stretch", () => {
    expect(liveness(running(at(100)), T0 + 160_000)).toEqual({
      kind: "live",
      lastSignalAt: at(100),
    });
    expect(liveness(running(at(100)), T0 + 100_000 + STALE_AFTER_MS + 1)).toEqual({
      kind: "stale",
      quietSince: at(100),
    });
    // Entering the stage counts as a signal when nothing newer arrived.
    expect(liveness(running(null), T0 + 60_000)).toEqual({ kind: "live", lastSignalAt: at(25) });
  });

  it("never calls blocked or review work stale", () => {
    const long = T0 + 10 * STALE_AFTER_MS;
    const blocked = view(task("blocked"), [...launch(0), move("running", "blocked", 30)]);
    const review = view(task("ready_for_review"), [
      ...launch(0),
      move("running", "ready_for_review", 30),
    ]);
    expect(liveness(blocked, long)).toEqual({ kind: "not_live" });
    expect(liveness(review, long)).toEqual({ kind: "not_live" });
  });
});

describe("lifecycle lines", () => {
  it("states stage, timings and the last milestone, never an estimate", () => {
    const t = view(task("running", { lastActivityAt: at(700) }), [
      move("queued", "starting", 0),
      move("starting", "queued", 1, "launch.deferred"),
      ...launch(3, 2),
      ev("worker.responded", 30),
      ev("pull_request.opened", 600),
    ]);
    const lines = lifecycleLines(t, T0 + 740_000);
    expect(lines).toEqual([
      "stage: Working 11m 50s (attempt 2) · last worker signal 40s ago",
      "timings: queued 2s · preparing workspace 6s · starting worker 22s · working 11m 50s",
      "last milestone: PR opened 2m 20s ago",
    ]);
    const stale = lifecycleLines(t, T0 + 700_000 + 14 * 60_000).join("\n");
    expect(stale).toContain("no progress signal for 14m 0s");
    expect(stale).not.toMatch(/ETA|estimate/i);
  });

  it("formats durations down to the second", () => {
    expect([0, 12_000, 252_000, 7_500_000].map(formatDuration)).toEqual([
      "<1s",
      "12s",
      "4m 12s",
      "2h 5m",
    ]);
  });
});

describe("milestones", () => {
  it("labels lifecycle events and skips unknown ones", () => {
    expect(milestone(ev("launch.intent", 1, { attempt: 2 }))).toBe("Worker launching (attempt 2)");
    expect(milestone(ev("state.running", 1, { from: "blocked" }))).toBe("Unblocked");
    expect(milestone(ev("attention.raised", 1, { kind: "permission" }))).toBe(
      "Asked for permission",
    );
    expect(milestone(ev("worker.responded", 1))).toBe("Worker responded");
    expect(milestone(ev("pull_request.opened", 1))).toBe("PR opened");
    expect(milestone(ev("task.cancelled", 1))).toBe("Cancelled");
    expect(milestone(ev("task.accepted", 1))).toBe("Accepted");
    expect(milestone(ev("something.new" as TaskEventType, 1))).toBeNull();
  });
});
