import { join } from "node:path";

import { ClaudeAdapter, CodexAdapter, type HarnessAdapter } from "@ocd/adapters";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

// End-to-end through the supervisor with the real adapters driving fake
// Claude Code / Codex binaries (test fixtures). No model is called.

const fixtures = join(import.meta.dirname, "..", "..", "adapters", "test-fixtures");
const harnesses: { name: "claude" | "codex"; adapter: () => HarnessAdapter; model: string }[] = [
  {
    name: "claude",
    adapter: () =>
      new ClaudeAdapter({ command: [process.execPath, join(fixtures, "fake-claude.mjs")] }),
    model: "sonnet#high",
  },
  {
    name: "codex",
    adapter: () =>
      new CodexAdapter({
        command: [process.execPath, join(fixtures, "fake-codex-app-server.mjs")],
      }),
    model: "gpt-5-codex#high",
  },
];

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

for (const harness of harnesses) {
  describe(`${harness.name} workers`, () => {
    const start = () =>
      startHarness({
        adapters: () => [harness.adapter()],
        config: {
          profiles: { w: { harness: harness.name, model: harness.model, permissionPolicy: "ask" } },
        },
      });
    const directive = harness.name === "claude" ? "[perm]" : "[approve-cmd]";

    it("gates a permission on the human and reaches review", async () => {
      h = await start();
      await setupRepo(h, "app", "w");
      const { task } = await h.human.dispatch({
        repo: "app",
        title: "t",
        instructions: `x ${directive}`,
        idempotencyKey: `${harness.name}-perm`,
      });
      const blocked = await waitForState(h, task.id, "blocked");
      const request = blocked.attention.find((a) => a.kind === "permission")!;
      expect(request.reason).toMatch(/npm publish/);
      await expect(
        h.manager("mgr").resolveAttention(request.id, { type: "approve" }),
      ).rejects.toMatchObject({ code: "human_only" });
      await h.human.resolveAttention(request.id, { type: "approve" });
      const done = await waitForState(h, task.id, "ready_for_review");
      expect(done.task.result?.reported?.summary).toBe(`${harness.name} did it`);
    });

    it("interrupts on supervisor loss and reattaches from disk", async () => {
      h = await start();
      const harnessRef = h;
      await setupRepo(h, "app", "w");
      const { task } = await h.human.dispatch({
        repo: "app",
        title: "t",
        instructions: "x [hang]",
        idempotencyKey: `${harness.name}-hang`,
      });
      const running = await waitForState(h, task.id, "running");
      await h.daemon.kill();
      await h.restart();
      await waitForState(h, task.id, "interrupted");
      await h.human.resumeTask(task.id, "reattach");
      const done = await waitFor(
        () => harnessRef.human.inspectTask(task.id),
        (d) => d.task.state === "ready_for_review",
      );
      expect(done.task.sessionId).toBe(running.task.sessionId);
    });
  });
}
