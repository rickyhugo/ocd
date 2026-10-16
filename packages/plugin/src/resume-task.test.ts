import { existsSync } from "node:fs";
import { join } from "node:path";

import { fakeReport, type FakeStep } from "@ocd/adapters";
import { setupRepo, startHarness, waitForState, type Harness } from "@ocd/supervisor/testkit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildTools, runTool } from "./tools.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

function managerTools(harness: Harness) {
  const tools = new Map(
    buildTools((sessionId, directory) => harness.manager(sessionId, directory)).map((t) => [
      t.name,
      t,
    ]),
  );
  let calls = 0;
  return (name: string, input: unknown, directory = harness.managerDirectory) =>
    runTool(tools.get(name)!, input, {
      sessionID: "ses_mgr",
      callID: `call_${(calls += 1)}`,
      directory,
    });
}

async function dispatch(instructions: string, key: string) {
  const { task } = await h.human.dispatch({
    repo: "app",
    title: "Resume",
    instructions,
    idempotencyKey: key,
  });
  return task;
}

describe("the manager's resume_task", () => {
  it("continues a needs_attention task in the same session and workspace", async () => {
    let turns = 0;
    h = await startHarness({
      fake: {
        script: (): FakeStep[] =>
          (turns += 1) === 1
            ? [
                { type: "write", file: "first.txt", content: "one" },
                { type: "reply", text: "Waiting on a subagent, back soon." },
              ]
            : [
                { type: "write", file: "second.txt", content: "two" },
                { type: "reply", text: fakeReport("Finished", ["first.txt", "second.txt"]) },
              ],
      },
    });
    await setupRepo(h, "app");
    const run = managerTools(h);
    const task = await dispatch("write two files", "resume-ok");
    const stopped = await waitForState(h, task.id, "needs_attention");

    const sent = await run("send_to_worker", { id: task.id, instructions: "carry on" });
    expect(sent).toMatch(/^OCD error \(not_steerable\)/);
    expect(sent).toContain("ocd_resume_task");

    expect(await run("resume_task", { id: task.id })).toMatch(/^Resumed\. /);
    const done = await waitForState(h, task.id, "ready_for_review");
    expect(done.task.id).toBe(stopped.task.id);
    expect(done.task.sessionId).toBe(stopped.task.sessionId);
    expect(done.task.workspacePath).toBe(stopped.task.workspacePath);
    expect(done.runs).toHaveLength(1);
    expect(existsSync(join(done.task.workspacePath!, "first.txt"))).toBe(true);
    expect(existsSync(join(done.task.workspacePath!, "second.txt"))).toBe(true);
    expect(done.events.find((e) => e.type === "task.resumed")?.data).toMatchObject({
      data: { mode: "reattach", actor: "manager" },
    });
  });

  it("refuses a manual task, and send_to_worker gives the same reason", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const run = managerTools(h);
    const task = await dispatch("work [fake:hang]", "resume-manual");
    await waitForState(h, task.id, "running");
    await h.human.takeOverTask(task.id);

    const resumed = await run("resume_task", { id: task.id });
    expect(resumed).toMatch(/^OCD error \(not_resumable\)/);
    expect(resumed).toContain("the human is driving its session");
    const sent = await run("send_to_worker", { id: task.id, instructions: "more" });
    expect(sent).toMatch(/^OCD error \(not_steerable\)/);
    expect(sent).toContain("the human is driving its session");
    expect(sent).not.toContain("ocd_resume_task");
    expect((await h.human.inspectTask(task.id)).task.state).toBe("manual");
  });

  it("refuses a task that is ready for review", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const run = managerTools(h);
    const task = await dispatch("write it", "resume-review");
    await waitForState(h, task.id, "ready_for_review");

    expect(await run("resume_task", { id: task.id })).toMatch(/^OCD error \(not_resumable\)/);
    expect((await h.human.inspectTask(task.id)).task.state).toBe("ready_for_review");
  });

  it("approves nothing: an open permission request stays with the human", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const run = managerTools(h);
    const task = await dispatch("clean up [fake:permission]", "resume-permission");
    const blocked = await waitForState(h, task.id, "blocked");
    const permission = blocked.attention.find((a) => a.kind === "permission")!;
    expect(permission.status).toBe("open");

    expect(await run("resume_task", { id: task.id })).toMatch(/^Resumed\. /);
    const after = await waitForState(h, task.id, "blocked");
    expect(after.attention.find((a) => a.id === permission.id)?.status).toBe("open");
    expect(h.fakeState.sessions.get(after.task.sessionId!)?.pending.size).toBe(1);
    expect(existsSync(join(after.task.workspacePath!, "ocd-fake.txt"))).toBe(false);
  });

  it("is refused for a session outside the manager directory", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const run = managerTools(h);
    const task = await dispatch("write it [fake:no-report]", "resume-caller");
    await waitForState(h, task.id, "needs_attention");

    expect(await run("resume_task", { id: task.id }, h.root)).toMatch(/^OCD error \(not_manager\)/);
    expect((await h.human.inspectTask(task.id)).task.state).toBe("needs_attention");
  });
});
