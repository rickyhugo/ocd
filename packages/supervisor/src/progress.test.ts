import { OcdApiError } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("task progress", () => {
  it("serves the latest reported checklist and recent events, read-only", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "Checklist",
      instructions: "[fake:todos] do it",
      idempotencyKey: "progress-1",
    });
    const progress = await waitFor(
      () => h.human.taskProgress(task.id),
      (p) => p.todos?.[1]?.status === "in_progress",
    );
    expect(progress).toMatchObject({
      taskId: task.id,
      todosSupported: true,
      todos: [
        { text: "Read the code", status: "completed" },
        { text: "Make the change", status: "in_progress" },
        { text: "Run the tests", status: "pending" },
      ],
    });
    expect(progress.todosUpdatedAt).not.toBeNull();
    expect(progress.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["task.created", "launch.intent", "prompt.intent"]),
    );

    // Looking at progress changes nothing: same task, no new prompt to the worker.
    const before = (await h.human.inspectTask(task.id)).task;
    const prompts = h.fakeState.promptCount;
    await h.human.taskProgress(task.id);
    await h.manager("mgr-session").taskProgress(task.id);
    const after = (await h.human.inspectTask(task.id)).task;
    expect(after.state).toBe("running");
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(h.fakeState.promptCount).toBe(prompts);

    await h.human.cancelTask(task.id);
    await waitForState(h, task.id, "cancelled");
  });

  it("reports no checklist yet, bounds events, and 404s unknown tasks", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "Plain",
      instructions: "Write the file",
      idempotencyKey: "progress-2",
    });
    await waitForState(h, task.id, "ready_for_review");
    const progress = await h.human.taskProgress(task.id);
    expect(progress).toMatchObject({ todosSupported: true, todos: null, todosUpdatedAt: null });
    expect(progress.events.length).toBeGreaterThan(0);
    expect(progress.events.length).toBeLessThanOrEqual(40);

    const missing = await h.human.taskProgress("t_missing").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OcdApiError);
    expect((missing as OcdApiError).status).toBe(404);
  });
});
