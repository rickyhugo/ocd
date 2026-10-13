import { join } from "node:path";

import {
  OcdClient,
  SupervisorUnavailableError,
  buildSpill,
  collectSpill,
  formatSpill,
} from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, tempDir, waitForState, type Harness } from "./testkit.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("/spill against a live supervisor", () => {
  it("summarizes open work across repos from supervisor records without changing anything", async () => {
    h = await startHarness({ config: { concurrency: 3 } });
    await setupRepo(h, "app");
    await setupRepo(h, "web");
    const dispatch = async (repo: string, title: string, instructions: string) =>
      (await h!.human.dispatch({ repo, title, instructions, idempotencyKey: `spill-${title}` }))
        .task;

    const done = await dispatch("app", "Finished work", "write a file");
    await waitForState(h, done.id, "ready_for_review");
    const running = await dispatch("app", "Long job", "work [fake:hang]");
    const blocked = await dispatch("web", "Needs approval", "cleanup [fake:permission]");
    await waitForState(h, running.id, "running");
    await waitForState(h, blocked.id, "blocked");
    // Accepted (completed) work is history and must not be listed.
    const accepted = await dispatch("web", "Accepted work", "write a file");
    await waitForState(h, accepted.id, "ready_for_review");
    await h.human.acceptTask(accepted.id);

    const before = await Promise.all(
      [done, running, blocked, accepted].map((t) => h!.human.inspectTask(t.id)),
    );
    const prompts = h.fakeState.promptCount;
    const wakes = h.managerChannel.sent.length;

    const text = formatSpill(buildSpill(await collectSpill(h.human)));
    expect(text.split("\n")[0]).toBe("OCD · 1 running · 1 blocked/waiting · 1 ready for review");
    expect(text).toMatch(
      new RegExp(
        `● Long job\\n {4}app · running \\S+ · active (just now|\\S+ ago) · latest: instructions sent .+ · ${running.id}`,
      ),
    );
    expect(text).toMatch(
      new RegExp(
        `! Needs approval\\n {4}web · waits on you: permission, .*rm -rf build.* · ${blocked.id}`,
      ),
    );
    expect(text).toMatch(
      new RegExp(
        `✓ Finished work\\n {4}app · ready \\S+ · 1 file, 0 commits, uncommitted changes · ${done.id}`,
      ),
    );
    expect(text).not.toContain(accepted.id);
    expect(text).not.toContain("[fake:");

    // Read-only: no transitions, events, prompts or manager wake-ups.
    const after = await Promise.all(
      [done, running, blocked, accepted].map((t) => h!.human.inspectTask(t.id)),
    );
    expect(after.map((d) => [d.task.state, d.task.updatedAt, d.events.length])).toEqual(
      before.map((d) => [d.task.state, d.task.updatedAt, d.events.length]),
    );
    expect(h.fakeState.promptCount).toBe(prompts);
    expect(h.managerChannel.sent.length).toBe(wakes);
  });

  it("works for a manager-actor client and shows the empty state", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const text = formatSpill(buildSpill(await collectSpill(h.manager("mgr"))));
    expect(text).toBe("OCD · 0 running\n\nNothing running, queued, blocked or waiting for review.");
  });

  it("fails clearly when the supervisor is unreachable", async () => {
    const client = new OcdClient({
      socketPath: join(tempDir(), "missing.sock"),
      actor: "human",
      timeoutMs: 1000,
    });
    await expect(collectSpill(client)).rejects.toBeInstanceOf(SupervisorUnavailableError);
  });
});
