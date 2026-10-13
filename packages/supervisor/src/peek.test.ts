import { defaultFakeScript } from "@ocd/adapters";
import { OcdClient, TRANSCRIPT_LIMITS, type Task } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

async function dispatch(instructions: string, key: string): Promise<Task> {
  const { task } = await h.human.dispatch({
    repo: "app",
    title: "Peek",
    instructions,
    idempotencyKey: key,
  });
  return task;
}

/** Everything a peek must leave untouched. */
async function footprint(taskId: string) {
  const d = await h.human.inspectTask(taskId);
  return {
    task: d.task,
    events: d.events.length,
    runs: d.runs,
    attention: d.attention.length,
    prompts: h.fakeState.promptCount,
    created: h.fakeState.createdCount,
    live: [...h.fakeState.sessions.keys()],
    onDisk: [...h.fakeState.onDisk.keys()],
  };
}

describe("peeking at worker transcripts", () => {
  it("shows a reviewed and then completed task's activity without touching the worker", async () => {
    h = await startHarness();
    await setupRepo(h);
    const task = await dispatch("write it, token=abcdef123456", "peek-key-1");
    await waitForState(h, task.id, "ready_for_review");

    const before = await footprint(task.id);
    const t = await h.human.peekTask(task.id);
    expect(t).toMatchObject({
      taskId: task.id,
      available: true,
      source: "live_buffer",
      untrusted: true,
      // The fake harness, like Claude Code, has no documented summary field.
      reasoningSummaries: "unsupported",
    });
    expect(t.notice).toMatch(/untrusted/i);
    expect(t.entries.map((e) => e.kind)).toEqual(["tool", "message"]);
    expect(t.entries[0]!.tool).toMatchObject({ name: "write", status: "completed" });
    expect(t.entries[1]!.text).toMatch(/ocd-report/);
    // The prompt (instructions, with its secret) is never part of the transcript.
    expect(JSON.stringify(t)).not.toContain("abcdef123456");
    expect(JSON.stringify(t)).not.toContain("write it");
    // Peeking repeatedly changes nothing about the task or the worker.
    await h.human.peekTask(task.id, { limit: 1, reasoningSummaries: true });
    expect(await footprint(task.id)).toEqual(before);

    // Accepting releases the worker; its snapshot stays readable, honestly labelled.
    await h.human.acceptTask(task.id);
    const done = await h.human.peekTask(task.id);
    expect(done).toMatchObject({
      taskState: "completed",
      available: true,
      source: "retained_buffer",
    });
    expect(done.notes.join(" ")).toMatch(/released/);
    expect(h.fakeState.sessions.has(task.sessionId ?? done.sessionId!)).toBe(false);
  });

  it("lets the manager peek but not workers, other directories or unauthenticated callers", async () => {
    h = await startHarness();
    await setupRepo(h);
    const task = await dispatch("write it", "peek-key-2");
    const ready = await waitForState(h, task.id, "ready_for_review");

    expect((await h.manager("mgr").peekTask(task.id)).available).toBe(true);
    await expect(h.manager("mgr", h.root).peekTask(task.id)).rejects.toMatchObject({
      code: "not_manager",
    });
    await expect(h.manager(ready.task.sessionId!).peekTask(task.id)).rejects.toMatchObject({
      code: "worker_session",
    });
    const forged = new OcdClient({
      socketPath: h.paths.socket,
      actor: "human",
      token: "x".repeat(64),
    });
    await expect(forged.peekTask(task.id)).rejects.toMatchObject({ status: 401 });
    await expect(h.human.peekTask("t_missing")).rejects.toMatchObject({ status: 404 });
    await expect(h.human.peekTask(task.id, { limit: 1000 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("binds paging cursors to the task's session", async () => {
    h = await startHarness();
    await setupRepo(h);
    const a = await dispatch("write a", "peek-key-3a");
    const b = await dispatch("write b", "peek-key-3b");
    await waitForState(h, a.id, "ready_for_review");
    await waitForState(h, b.id, "ready_for_review");

    const latest = await h.human.peekTask(a.id, { limit: 1 });
    expect(latest.entries).toHaveLength(1);
    expect(latest.before).not.toBeNull();
    const older = await h.human.peekTask(a.id, { limit: 1, before: latest.before! });
    expect(older.entries.map((e) => e.kind)).toEqual(["tool"]);
    expect(older.before).toBeNull();

    // Another task's cursor, or a forged one, is refused instead of read elsewhere.
    await expect(h.human.peekTask(b.id, { before: latest.before! })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    const forged = Buffer.from(JSON.stringify({ t: a.id, s: "fake_other", b: "1" })).toString(
      "base64url",
    );
    await expect(h.human.peekTask(a.id, { before: forged })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
    await expect(h.human.peekTask(a.id, { before: "garbage" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("reads a manual-mode task without changing it", async () => {
    h = await startHarness({
      fake: {
        script: (prompt, spec) =>
          prompt.includes("[slow]")
            ? [{ type: "reply", text: "Halfway there" }, { type: "hang" }]
            : defaultFakeScript(prompt, spec),
      },
    });
    await setupRepo(h);
    const task = await dispatch("work [slow]", "peek-key-4");
    await waitFor(
      () => h.human.peekTask(task.id),
      (t) => t.taskState === "running" && t.entries.length === 1,
    );
    await h.human.takeOverTask(task.id);

    const before = await footprint(task.id);
    const t = await h.human.peekTask(task.id);
    expect(t).toMatchObject({ taskState: "manual", available: true, source: "retained_buffer" });
    expect(t.entries.map((e) => e.text)).toEqual(["Halfway there"]);
    expect(t.notes.join(" ")).toMatch(/manual mode/);
    expect(await h.manager("mgr").peekTask(task.id)).toMatchObject({ taskState: "manual" });
    expect(await footprint(task.id)).toEqual(before);
  });

  it("says plainly when nothing is available, without reviving anything", async () => {
    h = await startHarness();
    await setupRepo(h);
    await h.human.pause();
    const queued = await dispatch("write it", "peek-key-5q");
    const none = await h.human.peekTask(queued.id);
    expect(none).toMatchObject({ available: false, entries: [], source: null });
    expect(none.notes.join(" ")).toMatch(/no worker session yet/);
    await h.human.resume();
    await waitForState(h, queued.id, "ready_for_review");

    // A restarted supervisor never saw this process-owned worker.
    await h.daemon.stop();
    await h.restart();
    const created = h.fakeState.createdCount;
    const after = await h.human.peekTask(queued.id);
    expect(after).toMatchObject({ available: false, taskState: "ready_for_review" });
    expect(after.notes.join(" ")).toMatch(/in memory only.*never resumes/);
    expect(h.fakeState.createdCount).toBe(created);
    expect([...h.fakeState.sessions.keys()]).toEqual([]);
  });

  it("keeps responses bounded and still pages through everything", async () => {
    h = await startHarness({
      fake: {
        script: (prompt, spec) =>
          prompt.includes("[chatty]")
            ? Array.from({ length: 40 }, (_, i) => ({
                type: "reply" as const,
                text: `${String(i).padStart(2, "0")} ${"x".repeat(3990)}`,
              }))
            : defaultFakeScript(prompt, spec),
      },
    });
    await setupRepo(h);
    const task = await dispatch("talk [chatty]", "peek-key-7");
    await waitFor(
      () => h.human.peekTask(task.id, { limit: 100 }),
      (t) => t.entries.at(-1)?.text?.startsWith("39 ") === true,
    );
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i++) {
      const t = await h.human.peekTask(task.id, { limit: 100, ...(before ? { before } : {}) });
      const size = t.entries.reduce((n, e) => n + (e.text?.length ?? 0), 0);
      expect(size).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.responseChars);
      if (i === 0) expect(t.notes.join(" ")).toMatch(/fit in one response/);
      seen.unshift(...t.entries.map((e) => e.text!.slice(0, 2)));
      if (!t.before) break;
      before = t.before;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => String(i).padStart(2, "0")));
  });

  it("turns adapter failures and timeouts into explicit unavailability", async () => {
    h = await startHarness({ hooks: { peekTimeoutMs: 100 } });
    await setupRepo(h);
    const task = await dispatch("write it", "peek-key-6");
    await waitForState(h, task.id, "ready_for_review");

    h.fakeState.transcriptFault = "error";
    const failed = await h.human.peekTask(task.id);
    expect(failed.available).toBe(false);
    expect(failed.notes.join(" ")).toMatch(/failed: fake transcript failure/);

    h.fakeState.transcriptFault = "hang";
    const slow = await h.human.peekTask(task.id);
    expect(slow.available).toBe(false);
    expect(slow.notes.join(" ")).toMatch(/timed out/);

    h.fakeState.transcriptFault = null;
    expect((await h.human.peekTask(task.id)).available).toBe(true);
    expect((await h.human.inspectTask(task.id)).task.state).toBe("ready_for_review");
  });
});
