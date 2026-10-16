import { rmSync } from "node:fs";
import { join } from "node:path";

import { systemScheduler, type AttentionKind } from "@ocd/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SupervisorConfig } from "./config.ts";
import { prepareDatabase } from "./daemon.ts";
import type { Db } from "./db/index.ts";
import { createLogger, type Logger } from "./logger.ts";
import { RecordingManagerChannel, RecordingNotifier } from "./notify.ts";
import { digest, OutboxWorker } from "./outbox.ts";
import { Store } from "./store.ts";
import {
  setupRepo,
  startHarness,
  tempDir,
  testPaths,
  waitFor,
  waitForState,
  type Harness,
} from "./testkit.ts";

const WINDOW = 3000;

const alert = (taskId: string | null, kind: AttentionKind) => ({
  title: `OCD: ${taskId ? `${kind} · ${taskId}` : kind}`,
  body: `${kind} reason`,
  ...(taskId ? { taskId } : {}),
  kind,
});

describe("digest", () => {
  it("sends a lone notification unchanged", () => {
    expect(digest([alert("t_1", "review")])).toEqual(alert("t_1", "review"));
  });

  it("summarises review-ready tasks and tasks that need you", () => {
    const message = digest([
      alert("t_1", "review"),
      alert("t_2", "review"),
      alert("t_3", "question"),
      alert("t_4", "review"),
      alert("t_5", "review"),
    ]);
    expect(message.title).toBe("OCD: 4 ready for review, 1 needs you");
    expect(message.body).toBe("Needs you: question · t_3\nReady for review: t_1, t_2, t_4, t_5");
    expect(digest([alert("t_1", "permission"), alert(null, "failure")]).title).toBe(
      "OCD: 2 need you",
    );
  });

  it("names tasks by their title when the notification has one", () => {
    const titled = (taskId: string, kind: AttentionKind, title: string, subject: string) => ({
      title: `OCD: ${title}`,
      body: subject,
      taskId,
      kind,
      subject,
    });
    const message = digest([
      titled("t_1", "permission", "Permission needed", "Fix login loop"),
      titled("t_2", "review", "Review ready", "Add dark mode"),
    ]);
    expect(message.body).toBe(
      "Needs you: Fix login loop (Permission needed)\nReady for review: Add dark mode",
    );
  });

  it("counts each task once, as its latest notification", () => {
    // t_1 asked a question, was answered, and finished; t_2 notified twice.
    const message = digest([
      alert("t_1", "question"),
      alert("t_2", "review"),
      alert("t_1", "review"),
      alert("t_2", "review"),
    ]);
    expect(message.title).toBe("OCD: 2 ready for review");
    expect(message.body).toBe("Ready for review: t_1, t_2");
    expect(digest([alert("t_1", "question"), alert("t_1", "review")]).title).toBe(
      "OCD: review · t_1",
    );
  });
});

describe("notification digests in the outbox worker", () => {
  let db: Db;
  let store: Store;
  let notifier: RecordingNotifier;
  let managerChannel: RecordingManagerChannel;
  let worker: OutboxWorker;
  let logger: Logger;
  let root: string;
  let seq = 0;

  const notify = (taskId: string | null, kind: AttentionKind) =>
    store.enqueue([{ kind: "notify", dedupeKey: `n${(seq += 1)}`, payload: alert(taskId, kind) }]);
  const makeWorker = (config: Record<string, unknown> = {}) =>
    new OutboxWorker(
      store,
      SupervisorConfig.parse({
        outbox: { intervalMs: 60_000, maxAttempts: 3, baseDelayMs: 1000 },
        notifications: { digestWindowMs: WINDOW },
        ...config,
      }),
      notifier,
      managerChannel,
      logger,
      systemScheduler,
    );

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00Z") });
    root = tempDir();
    db = await prepareDatabase(testPaths(join(root, "home")));
    store = new Store(db, systemScheduler);
    notifier = new RecordingNotifier();
    managerChannel = new RecordingManagerChannel();
    logger = createLogger({ level: "silent" });
    worker = makeWorker();
    worker.start();
  });

  afterEach(async () => {
    await worker.stop();
    vi.useRealTimers();
    db.$client.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("holds a single notification for the window, then sends it unchanged", async () => {
    notify("t_1", "review");
    await worker.flush();
    expect(notifier.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WINDOW - 1);
    expect(notifier.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(notifier.sent).toEqual([alert("t_1", "review")]);
    expect(store.listOutbox("pending")).toHaveLength(0);
  });

  it("sends one digest for notifications raised within one window", async () => {
    for (const id of ["t_1", "t_2", "t_3"]) notify(id, "review");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(1000);
    notify("t_4", "review");
    notify("t_5", "permission");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(WINDOW - 1000);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.title).toBe("OCD: 4 ready for review, 1 needs you");
    expect(notifier.sent[0]?.body).toContain("permission · t_5");
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    expect(notifier.sent).toHaveLength(1);
  });

  it("does not double-count a task whose status changes within the window", async () => {
    notify("t_1", "question");
    notify("t_2", "review");
    notify("t_1", "review");
    notify("t_2", "review");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(notifier.sent).toEqual([
      { title: "OCD: 2 ready for review", body: "Ready for review: t_1, t_2" },
    ]);
  });

  it("notifies later windows independently", async () => {
    notify("t_1", "review");
    notify("t_2", "review");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(notifier.sent.map((n) => n.title)).toEqual(["OCD: 2 ready for review"]);

    await vi.advanceTimersByTimeAsync(10_000);
    notify("t_1", "review");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(notifier.sent.map((n) => n.title)).toEqual([
      "OCD: 2 ready for review",
      "OCD: review · t_1",
    ]);
  });

  it("does not hold manager wake-ups for the notification window", async () => {
    store.activateManager("mgr", "/manager");
    notify("t_1", "review");
    store.enqueue([
      { kind: "manager_wake", dedupeKey: "wake-1", payload: { text: "t_1 ready", taskId: "t_1" } },
    ]);
    await worker.flush();
    expect(managerChannel.sent).toHaveLength(1);
    expect(notifier.sent).toHaveLength(0);
  });

  it("retries a failed digest as one message, without waiting for a new window", async () => {
    notifier.failNext = 1;
    notify("t_1", "review");
    notify("t_2", "question");
    await worker.flush();
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(notifier.sent).toHaveLength(0);
    const pending = store.listOutbox("pending");
    expect(pending.map((e) => e.attempts)).toEqual([1, 1]);

    await vi.advanceTimersByTimeAsync(1000); // baseDelayMs
    await worker.flush();
    expect(notifier.sent.map((n) => n.title)).toEqual(["OCD: 1 ready for review, 1 needs you"]);
    expect(store.listOutbox("pending")).toHaveLength(0);
  });

  it("logs a failed timer-driven pass instead of leaving an unhandled rejection", async () => {
    const error = vi.spyOn(logger, "error");
    const due = vi.spyOn(store, "dueOutbox").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    notify("t_1", "review");
    await vi.advanceTimersByTimeAsync(60_000); // the interval pass
    expect(error).toHaveBeenCalledWith(expect.anything(), "outbox pass failed");
    due.mockRestore();
    await worker.flush();
    expect(notifier.sent).toHaveLength(1);
  });

  it("cancels the window timer on stop and sends held notifications on the final flush", async () => {
    notify("t_1", "review");
    notify("t_2", "review");
    await worker.flush();
    await worker.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(notifier.sent).toHaveLength(0);
    // The supervisor's shutdown flush: nothing would fire later, so send now.
    await worker.flush();
    expect(notifier.sent.map((n) => n.title)).toEqual(["OCD: 2 ready for review"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops notifications without waiting when they are disabled", async () => {
    await worker.stop();
    worker = makeWorker({ notifications: { enabled: false, digestWindowMs: WINDOW } });
    notify("t_1", "review");
    await worker.flush();
    expect(notifier.sent).toHaveLength(0);
    expect(store.listOutbox("pending")).toHaveLength(0);
  });
});

describe("notification digests end to end", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("sends one notification for tasks that finish together, and wakes the manager per pass", async () => {
    h = await startHarness({ config: { concurrency: 2, notifications: { digestWindowMs: 1500 } } });
    await setupRepo(h, "app");
    await h.manager("mgr").listTasks();
    const tasks = await Promise.all(
      ["a", "b"].map(async (title) => {
        const { task } = await h.human.dispatch({
          repo: "app",
          title,
          instructions: "x",
          idempotencyKey: `digest-${title}`,
        });
        return task;
      }),
    );
    for (const task of tasks) await waitForState(h, task.id, "ready_for_review");
    await waitFor(
      () => h.managerChannel.sent.length,
      (n) => n >= 1,
    );
    expect(h.notifier.sent).toHaveLength(0);
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n >= 1,
    );
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]?.title).toBe("OCD: 2 ready for review");
    expect(h.notifier.sent[0]?.body).toBe("Ready for review: a, b");
  });
});
