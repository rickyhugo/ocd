import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { backupDb, openDb } from "./db/index.ts";
import { SimulatedCrash } from "./errors.ts";
import type { CrashPoint } from "./supervisor.ts";
import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

function crashAt(point: CrashPoint) {
  let fired = false;
  return {
    at: (p: CrashPoint) => {
      if (p === point && !fired) {
        fired = true;
        throw new SimulatedCrash(point);
      }
    },
  };
}

async function crashThenRestart(point: CrashPoint, survive: boolean, instructions = "write it") {
  h = await startHarness({ hooks: crashAt(point), fake: { survive } });
  await setupRepo(h, "app");
  const { task } = await h.human.dispatch({
    repo: "app",
    title: "t",
    instructions,
    idempotencyKey: `crash-${point}`,
  });
  await h.daemon.closed;
  await h.restart({ hooks: {} });
  return task.id;
}

describe("crash boundaries (AT5)", () => {
  it("before launch: re-queues and launches exactly once", async () => {
    const id = await crashThenRestart("after_intent", false);
    const d = await waitForState(h, id, "ready_for_review");
    expect(h.fakeState.promptCount).toBe(1);
    expect(d.runs.map((r) => r.exitReason)).toEqual(["not_admitted", "idle"]);
  });

  it("after session creation but before the ID was persisted: adopts the session, prompts once", async () => {
    const id = await crashThenRestart("after_session_created", true);
    await waitForState(h, id, "ready_for_review");
    expect(h.fakeState.createdCount).toBe(1);
    expect(h.fakeState.promptCount).toBe(1);
  });

  it("after ID persistence but before the prompt: finishes the launch without duplicating it", async () => {
    const id = await crashThenRestart("after_session_persisted", true);
    await waitForState(h, id, "ready_for_review");
    expect(h.fakeState.createdCount).toBe(1);
    expect(h.fakeState.promptCount).toBe(1);
  });

  it("after the prompt with a surviving session: reattaches, never re-prompts", async () => {
    const id = await crashThenRestart("after_prompt", true);
    await waitForState(h, id, "ready_for_review");
    expect(h.fakeState.promptCount).toBe(1);
  });

  it("after the prompt when the worker died with the supervisor: raises an ambiguous-launch request", async () => {
    const id = await crashThenRestart("after_prompt", false);
    const d = await waitForState(h, id, "needs_attention");
    expect(d.attention.map((a) => a.kind)).toContain("ambiguous_launch");
    expect(h.fakeState.promptCount).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.fakeState.promptCount).toBe(1);
  });

  it("a running worker lost with the supervisor becomes interrupted and preserves edits", async () => {
    h = await startHarness({
      fake: {
        survive: false,
        script: () => [{ type: "write", file: "wip.txt", content: "keep" }, { type: "hang" }],
      },
    });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "lost-1234",
    });
    const running = await waitFor(
      () => h.human.inspectTask(task.id),
      (d) =>
        d.task.state === "running" &&
        h.fakeState.sessions.size === 1 &&
        [...h.fakeState.sessions.values()][0]!.status === "busy",
    );
    await new Promise((r) => setTimeout(r, 50));
    await h.daemon.kill();
    await h.restart();
    const d = await waitForState(h, task.id, "interrupted");
    expect(d.attention.some((a) => a.kind === "failure" && a.status === "open")).toBe(true);
    expect(readFileSync(join(running.task.workspacePath!, "wip.txt"), "utf8")).toBe("keep");

    // Explicit, human-only recovery relaunches in the same workspace.
    await expect(h.manager("x").resumeTask(task.id, "relaunch")).rejects.toBeDefined();
    await h.human.resumeTask(task.id, "relaunch");
    await waitFor(
      () => h.human.inspectTask(task.id),
      (x) => x.runs.length === 2 && x.task.state === "running",
    );
  });
});

describe("event stream loss (AT6)", () => {
  it("reconciles state missed while the stream was down", async () => {
    h = await startHarness({ fake: { survive: true } });
    await setupRepo(h, "app");
    const listeners = [...h.fakeState.listeners];
    h.fakeState.listeners.clear(); // the stream silently drops
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "stream-1234",
    });
    await waitFor(
      () => h.fakeState.sessions.size,
      (n) => n === 1,
    );
    await waitFor(
      () => [...h.fakeState.sessions.values()][0]!.status,
      (s) => s === "idle",
    );
    expect((await h.human.inspectTask(task.id)).task.state).toBe("running");
    for (const l of listeners) h.fakeState.listeners.add(l);
    h.adapter.simulateReconnect();
    await waitForState(h, task.id, "ready_for_review");
  });
});

describe("stalls and sleep", () => {
  it("raises one rate-limited stall request for a busy, silent worker and never kills it", async () => {
    let now = Date.now();
    h = await startHarness({
      clock: () => now,
      fake: { script: () => [{ type: "hang" }] },
      config: { stallAfterMinutes: 30, reconcileIntervalMs: 60_000 },
    });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "stall-1234",
    });
    await waitForState(h, task.id, "running");
    now += 31 * 60_000;
    await h.daemon.supervisor.reconcile("periodic");
    await h.daemon.supervisor.reconcile("periodic");
    const d = await h.human.inspectTask(task.id);
    expect(d.attention.filter((a) => a.kind === "stall")).toHaveLength(1);
    expect(d.task.state).toBe("running");
  });
});

describe("database durability (AT13)", () => {
  it("restores a backup with unfinished work and decisions intact", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "unfinished",
      instructions: "x",
      idempotencyKey: "backup-1234",
    });
    await waitForState(h, task.id, "running");
    const decision = await h.human.recordDecision({ summary: "Use SQLite", repo: "app" });
    const backup = join(h.root, "backup.db");
    await backupDb(h.daemon.store.db, backup);
    await h.human.dispatch({
      repo: "app",
      title: "after backup",
      instructions: "y",
      idempotencyKey: "backup-5678",
    });
    await h.daemon.stop();

    // The manual restore the README documents.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(h.paths.db + suffix, { force: true });
    copyFileSync(backup, h.paths.db);
    const db = openDb(h.paths.db, { readonly: true });
    const titles = db.$client.prepare("SELECT title, state FROM tasks ORDER BY created_at").all();
    const decisions = db.$client.prepare("SELECT id FROM decisions").all();
    db.$client.close();
    expect(titles).toEqual([{ title: "unfinished", state: "running" }]);
    expect(decisions).toEqual([{ id: decision.id }]);

    await h.restart();
    // The restored running task's worker died with the old supervisor.
    await waitForState(h, task.id, "interrupted");
  });
});

describe("process-owned workers", () => {
  it("reattaches to a session from disk after the worker died with the supervisor", async () => {
    let calls = 0;
    h = await startHarness({
      fake: {
        survive: false,
        script: () => {
          calls += 1;
          return calls === 1
            ? [{ type: "write", file: "part1.txt", content: "1" }, { type: "hang" }]
            : [
                { type: "write", file: "part2.txt", content: "2" },
                { type: "reply", text: '```ocd-report\n{"summary":"resumed"}\n```' },
              ];
        },
      },
    });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "revive-1",
    });
    const running = await waitFor(
      () => h.human.inspectTask(task.id),
      (d) =>
        d.task.state === "running" &&
        h.fakeState.sessions.get(d.task.sessionId!)?.status === "busy",
    );
    await new Promise((r) => setTimeout(r, 50));
    await h.daemon.kill();
    await h.restart();
    await waitForState(h, task.id, "interrupted");
    await h.human.resumeTask(task.id, "reattach");
    const done = await waitForState(h, task.id, "ready_for_review");
    expect(done.task.sessionId).toBe(running.task.sessionId);
    expect(done.runs).toHaveLength(1);
    expect(done.task.result?.verification?.changedFiles).toEqual(["part1.txt", "part2.txt"]);
  });
});
