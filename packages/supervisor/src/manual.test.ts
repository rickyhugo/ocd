import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

async function dispatch(instructions: string, key: string) {
  const { task } = await h.human.dispatch({
    repo: "app",
    title: "Manual mode",
    instructions,
    idempotencyKey: key,
  });
  return task;
}

/** Wake texts delivered to the active manager session. */
async function wakes(): Promise<string> {
  await h.manager("mgr").listTasks(); // makes "mgr" the active manager session
  await waitFor(
    () => h.managerChannel.sent.length,
    (n) => n >= 1,
    5000,
  );
  return h.managerChannel.sent.map((w) => w.text).join("\n");
}

describe("manual mode (take over / give back)", () => {
  it("takes over a running worker: stops it, tells the manager, and leaves it alone", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const task = await dispatch("work [fake:hang]", "manual-1");
    await waitForState(h, task.id, "running");

    const taken = await h.human.takeOverTask(task.id);
    expect(taken.task.state).toBe("manual");
    expect(taken.command).toEqual(["fake-harness", "--resume", taken.task.sessionId]);
    expect(taken.cwd).toBe(taken.task.workspacePath);
    expect(taken.tmux).toBe(false);
    // The process-owned worker is stopped, its session kept for later.
    expect(h.fakeState.sessions.has(taken.task.sessionId!)).toBe(false);
    expect(h.fakeState.onDisk.has(taken.task.sessionId!)).toBe(true);

    // The interrupt's idle report must not finish the task.
    await delay(100);
    const detail = await h.human.inspectTask(task.id);
    expect(detail.task.state).toBe("manual");
    expect(detail.runs.at(-1)?.exitReason).toBe("taken_over");
    expect(await wakes()).toMatch(/\[manual\][\s\S]*Do not send it work/);
    // Taking over again only repeats the command.
    const again = await h.human.takeOverTask(task.id);
    expect(again.command).toEqual(taken.command);
    expect(h.managerChannel.sent.filter((w) => w.text.includes("[manual]"))).toHaveLength(1);

    // Only the human acts on a manual task.
    await expect(h.manager("mgr").cancelTask(task.id)).rejects.toMatchObject({
      code: "manual_mode",
    });
    await expect(h.manager("mgr").takeOverTask(task.id)).rejects.toMatchObject({
      code: "human_only",
    });
    await expect(h.manager("mgr").sendToWorker(task.id, "more")).rejects.toBeDefined();
  });

  it("tells the TUI it may open a tmux window only when tmux.enabled is on", async () => {
    h = await startHarness({ config: { tmux: { enabled: true } } });
    await setupRepo(h, "app");
    const task = await dispatch("work [fake:hang]", "manual-tmux");
    await waitForState(h, task.id, "running");
    expect((await h.human.takeOverTask(task.id)).tmux).toBe(true);
  });

  it("gives back to continue: refuses while the session is open elsewhere, then resumes with the note", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const task = await dispatch("work [fake:hang]", "manual-2");
    await waitForState(h, task.id, "running");
    const { task: manual } = await h.human.takeOverTask(task.id);

    h.fakeState.inUse.add(manual.sessionId!);
    await expect(
      h.human.giveBackTask(task.id, { mode: "continue", note: "fixed the parser" }),
    ).rejects.toMatchObject({ code: "session_in_use" });
    h.fakeState.inUse.delete(manual.sessionId!);

    const back = await h.human.giveBackTask(task.id, {
      mode: "continue",
      note: "fixed the parser",
    });
    expect(back.state).toBe("running");
    expect(h.fakeState.prompts.at(-1)).toMatch(/handed the task back[\s\S]*fixed the parser/);
    // The worker finishes normally afterwards and reports.
    await waitForState(h, task.id, "ready_for_review");
    expect(await wakes()).toMatch(/\[handed back\][\s\S]*worker continues/);
  });

  it("gives back for review: the task goes to review and the manager is told", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const task = await dispatch("write it", "manual-3");
    await waitForState(h, task.id, "ready_for_review");
    await waitFor(
      () => h.notifier.sent.length,
      (n) => n === 1,
    );
    await h.human.takeOverTask(task.id);
    const notified = h.notifier.sent.length;

    const back = await h.human.giveBackTask(task.id, { mode: "review", note: "done by hand" });
    expect(back.state).toBe("ready_for_review");
    expect(await wakes()).toMatch(/finished it by hand[\s\S]*done by hand/);
    // The human handed it back themselves: no desktop notification about it.
    await delay(100);
    expect(h.notifier.sent.length).toBe(notified);
    expect((await h.human.acceptTask(task.id)).state).toBe("completed");
  });

  it("rejects take-over without a session and give-back outside manual mode", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const task = await dispatch("write it", "manual-4");
    await waitForState(h, task.id, "ready_for_review");
    await expect(h.human.giveBackTask(task.id, { mode: "review" })).rejects.toMatchObject({
      code: "not_manual",
    });
    await h.human.acceptTask(task.id);
    await expect(h.human.takeOverTask(task.id)).rejects.toMatchObject({
      code: "not_takeoverable",
    });
  });
});
