import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("task lifecycle", () => {
  it("serves each stage a dispatched task went through, on list and inspect", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "Stages",
      instructions: "Write the file",
      idempotencyKey: "lifecycle-1",
    });
    await waitForState(h, task.id, "ready_for_review");

    const detail = await h.human.inspectTask(task.id);
    expect(detail.task.lifecycle.spans.map((s) => [s.stage, s.attempt])).toEqual([
      ["queued", 0],
      ["preparing_workspace", 1],
      ["starting_worker", 1],
      ["working", 1],
      ["review", 1],
    ]);
    expect(detail.task.lifecycle).toMatchObject({ stage: "review", attempt: 1 });
    expect(detail.events.filter((e) => e.type === "worker.responded")).toHaveLength(1);

    const [listed] = await h.human.listTasks({ open: true });
    expect(listed?.lifecycle).toEqual(detail.task.lifecycle);
  });

  it("asks a worker whose harness reports checklists to record its plan first", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "Plan",
      instructions: "[fake:todos] do it",
      idempotencyKey: "lifecycle-2",
    });
    const working = await waitFor(
      () => h.human.inspectTask(task.id),
      (d) => d.task.lifecycle.stage === "working",
    );
    expect(working.events.filter((e) => e.type === "worker.responded")).toHaveLength(1);
    expect(h.fakeState.prompts[0]).toContain("Start by recording a short plan");

    await h.human.cancelTask(task.id);
    await waitForState(h, task.id, "cancelled");
  });
});
