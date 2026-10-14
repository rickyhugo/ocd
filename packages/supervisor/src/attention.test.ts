import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("notifications and the outbox (AT9)", () => {
  it("retries failed notifications and delivers each alert once", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    h.notifier.failNext = 2;
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "notify-1",
    });
    await waitForState(h, task.id, "ready_for_review");
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 1,
    );
    await delay(100);
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]?.title).toBe("OCD: Review ready");
  });

  it("keeps undelivered notifications across a restart", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    h.notifier.failNext = 1_000;
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "notify-2",
    });
    await waitForState(h, task.id, "ready_for_review");
    await waitFor(
      () => h.human.listOutbox({ status: "pending" }),
      (o) => o.some((e) => e.kind === "notify" && e.attempts >= 1),
    );
    await h.daemon.stop();
    h.notifier.failNext = 0;
    await h.restart();
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 1,
    );
  });

  it("gives up after bounded attempts and surfaces the failure in the inbox, without alert loops", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    h.notifier.failNext = 1_000;
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x",
      idempotencyKey: "notify-3",
    });
    await waitForState(h, task.id, "ready_for_review");
    const dead = await waitFor(
      () => h.human.listOutbox({ status: "dead" }),
      (o) => o.length === 1,
    );
    expect(dead[0]?.attempts).toBe(3);
    const inbox = await h.human.listAttention({ status: "open" });
    expect(
      inbox.some(
        (a) => a.kind === "failure" && a.reason.includes("Could not deliver a notification"),
      ),
    ).toBe(true);
    await delay(150);
    expect((await h.human.listOutbox({ status: "dead" })).length).toBe(1);
    expect((await h.human.status()).outbox.dead).toBe(1);
  });

  it("redacts secrets from delivery errors before storing or surfacing them", async () => {
    h = await startHarness();
    const store = h.daemon.store;
    store.enqueue([{ kind: "notify", dedupeKey: "secret-err", payload: {} } as never]);
    const [entry] = store.listOutbox();
    store.markDeliveryFailed(
      [entry!.id],
      "POST https://user:pw12345@hooks.example.com failed, token=abcd1234efgh",
      1,
      10,
    );
    const [after] = store.listOutbox("dead");
    expect(after?.lastError).not.toMatch(/pw12345|abcd1234efgh/);
    const reasons = (await h.human.listAttention({ status: "open" })).map((a) => a.reason).join();
    expect(reasons).toContain("Could not deliver");
    expect(reasons).not.toMatch(/pw12345|abcd1234efgh/);
  });

  it("deduplicates repeated harness events", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x [fake:permission]",
      idempotencyKey: "dedupe-1",
    });
    const blocked = await waitForState(h, task.id, "blocked");
    const session = h.fakeState.sessions.get(blocked.task.sessionId!)!;
    const pending = [...session.pending.values()][0]!;
    const { settle: _settle, ...interaction } = pending;
    for (let i = 0; i < 3; i += 1)
      h.fakeState.emit({ type: "interaction", sessionId: session.id, interaction });
    await h.daemon.supervisor.reconcile("periodic");
    await delay(50);
    const detail = await h.human.inspectTask(task.id);
    expect(detail.attention.filter((a) => a.kind === "permission")).toHaveLength(1);
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 1,
    );
    await delay(100);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it("holds manager wake-ups until a manager exists, then coalesces them", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const a = await h.human.dispatch({
      repo: "app",
      title: "a",
      instructions: "x",
      idempotencyKey: "wake-key-a",
    });
    const b = await h.human.dispatch({
      repo: "app",
      title: "b",
      instructions: "x",
      idempotencyKey: "wake-key-b",
    });
    await waitForState(h, a.task.id, "ready_for_review");
    await waitForState(h, b.task.id, "ready_for_review");
    await delay(100);
    expect(h.managerChannel.sent).toHaveLength(0);
    const held = await h.human.listOutbox({ status: "pending" });
    expect(held.filter((e) => e.kind === "manager_wake" && e.attempts === 0).length).toBe(2);

    await h.manager("mgr").listTasks(); // a session in the manager directory becomes active
    await waitFor(
      () => h.managerChannel.sent.length,
      (n) => n >= 1,
      5000,
    );
    expect(h.managerChannel.sent).toHaveLength(1);
    expect(h.managerChannel.sent[0]?.sessionId).toBe("mgr");
    expect(h.managerChannel.sent[0]?.text).toContain(a.task.id);
    expect(h.managerChannel.sent[0]?.text).toContain(b.task.id);
    expect(h.managerChannel.sent[0]?.text).toMatch(/untrusted data/);
  });
});

describe("request expiry", () => {
  it("expires unanswered permission requests, denies them in the harness, and refuses late approvals", async () => {
    let now = Date.now();
    h = await startHarness({ clock: () => now, config: { attentionExpiryMinutes: 10 } });
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "x [fake:permission]",
      idempotencyKey: "expire-1",
    });
    const blocked = await waitForState(h, task.id, "blocked");
    const request = blocked.attention.find((a) => a.kind === "permission")!;
    now += 11 * 60_000;
    await expect(h.human.resolveAttention(request.id, { type: "approve" })).rejects.toMatchObject({
      code: "expired",
    });
    await h.daemon.supervisor.reconcile("periodic");
    const after = await waitForState(h, task.id, [
      "needs_attention",
      "running",
      "ready_for_review",
    ]);
    expect(after.attention.find((a) => a.id === request.id)?.status).toBe("expired");
    // The fake worker treats the denial as a stop, which is not success.
    expect(after.task.state).toBe("needs_attention");
  });
});
