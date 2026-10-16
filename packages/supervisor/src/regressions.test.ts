import { OpenCodeAdapter } from "@ocd/adapters";
import { FakeOpenCodeService } from "@ocd/adapters/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { systemScheduler } from "@ocd/core";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

// Regression tests for defects found in review of milestones 1-3.

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("review regressions", () => {
  it("a blocked worker that finishes while events were missed reaches review instead of sticking", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x [fake:permission]",
      idempotencyKey: "blocked-finish",
    });
    const blocked = await waitForState(h, task.id, "blocked");
    const session = h.fakeState.sessions.get(blocked.task.sessionId!)!;
    // The request is answered in the harness UI while OCD's stream is down.
    const listeners = [...h.fakeState.listeners];
    h.fakeState.listeners.clear();
    [...session.pending.values()][0]!.settle({ type: "approve" });
    await waitFor(
      () => session.status,
      (s) => s === "idle",
    );
    for (const l of listeners) h.fakeState.listeners.add(l);
    h.adapter.simulateReconnect();
    const done = await waitForState(h, task.id, "ready_for_review");
    expect(done.attention.find((a) => a.kind === "permission")?.status).toBe("expired");
    expect(done.attention.some((a) => a.kind === "review" && a.status === "open")).toBe(true);
  });

  it("a follow-up that finishes again raises a fresh review request and notification", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "followup-1",
    });
    await waitForState(h, task.id, "ready_for_review");
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 1,
    );
    await h.human.sendToWorker(task.id, "Also update the docs");
    await waitFor(
      () => h.human.inspectTask(task.id),
      (d) =>
        d.task.state === "ready_for_review" &&
        d.attention.filter((a) => a.kind === "review").length === 2,
    );
    const reviews = (await h.human.inspectTask(task.id)).attention.filter(
      (a) => a.kind === "review",
    );
    expect(reviews.map((a) => a.status).sort()).toEqual(["open", "resolved"]);
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 2,
    );
  });

  it("reattaching to a failed worker keeps its failure request until the resume succeeds", async () => {
    h = await startHarness({ fake: { survive: true } });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x [fake:error]",
      idempotencyKey: "reattach-failed",
    });
    const failed = await waitForState(h, task.id, "failed");
    const failure = failed.attention.find((a) => a.kind === "failure" && a.status === "open")!;

    // A missing session is refused without consuming the request.
    const session = h.fakeState.sessions.get(failed.task.sessionId!)!;
    h.fakeState.sessions.delete(session.id);
    await expect(h.human.resumeTask(task.id, "reattach")).rejects.toMatchObject({
      code: "session_missing",
    });
    let detail = await h.human.inspectTask(task.id);
    expect(detail.task.state).toBe("failed");
    expect(detail.attention.find((a) => a.id === failure.id)?.status).toBe("open");

    // With the session back, reattach continues it and settles the request.
    h.fakeState.sessions.set(session.id, session);
    await h.human.resumeTask(task.id, "reattach");
    detail = await waitForState(h, task.id, "ready_for_review");
    expect(detail.attention.find((a) => a.id === failure.id)?.status).toBe("resolved");
  });

  it("a queued task whose harness disappeared does not starve the queue", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    await h.human.pause();
    const a = await h.human.dispatch({
      repo: "app",
      title: "a",
      instructions: "x",
      idempotencyKey: "starve-a",
    });
    const b = await h.human.dispatch({
      repo: "app",
      title: "b",
      instructions: "x",
      idempotencyKey: "starve-b",
    });
    await h.daemon.stop();
    await h.restart({ adapters: () => [] });
    await h.human.resume();
    await waitForState(h, a.task.id, "needs_attention");
    await waitForState(h, b.task.id, "needs_attention");
  });

  it("an unreachable OpenCode service defers launches instead of marking them ambiguous", async () => {
    let now = Date.now();
    const service = new FakeOpenCodeService();
    h = await startHarness({
      scheduler: { ...systemScheduler, now: () => now },
      config: { profiles: { oc: { harness: "opencode", model: "anthropic/claude-x" } } },
      adapters: () => [
        new OpenCodeAdapter({
          connect: async () => ({ api: service.api, url: "http://fake" }),
          reconnectDelayMs: { min: 5, max: 20 },
        }),
      ],
    });
    await setupRepo(h, "app", "oc");
    service.down = true;
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "oc-down-1",
    });
    await waitFor(
      () => h.human.inspectTask(task.id),
      (d) => d.runs.length === 1 && d.task.state === "queued",
    );
    const inbox = await h.human.listAttention({ status: "open" });
    expect(inbox.filter((x) => x.reason.includes("unreachable"))).toHaveLength(1);
    expect(inbox.some((x) => x.kind === "ambiguous_launch")).toBe(false);

    service.down = false;
    now += 31_000;
    await waitFor(
      () => service.calls.filter((c) => c.method === "session.prompt").length,
      (n) => n === 1,
    );
    expect((await h.human.inspectTask(task.id)).runs).toHaveLength(2);
  });

  it("sessions from earlier attempts are still treated as workers", async () => {
    h = await startHarness({ fake: { survive: false, script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "old-worker",
    });
    const first = await waitForState(h, task.id, "running");
    await h.daemon.kill();
    await h.restart();
    await waitForState(h, task.id, "interrupted");
    await h.human.resumeTask(task.id, "relaunch");
    await waitFor(
      () => h.human.inspectTask(task.id),
      (d) => d.runs.length === 2 && d.task.state === "running",
    );
    await expect(h.manager(first.task.sessionId!).listTasks()).rejects.toMatchObject({
      code: "worker_session",
    });
  });
});
