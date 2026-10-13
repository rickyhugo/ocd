import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { OpenCodeAdapter } from "@ocd/adapters";
import { FakeOpenCodeService } from "@ocd/adapters/testing";
import { OcdClient } from "@ocd/core";
import { RecordingNotifier, createLogger, startDaemon, type Daemon } from "@ocd/supervisor";
import { makeRepo, rmrf, tempDir, testPaths, waitFor } from "@ocd/supervisor/testkit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BriefingCache } from "./briefing.ts";
import { buildTools, runTool, type OcdTool } from "./tools.ts";

let daemon: Daemon | null = null;
let root: string | null = null;
afterEach(async () => {
  await daemon?.stop().catch(() => undefined);
  daemon = null;
  if (root) rmrf(root);
});

async function boot(
  service: FakeOpenCodeService,
  paths: ReturnType<typeof testPaths>,
  repoPath: string,
) {
  return startDaemon({
    paths,
    config: {
      manager: { directory: join(paths.home, "..", "manager") },
      schedulerIntervalMs: 20,
      reconcileIntervalMs: 60_000,
      outbox: { intervalMs: 20, maxAttempts: 3, baseDelayMs: 10 },
      repos: { app: { path: repoPath, profile: "oc" } },
      profiles: {
        oc: {
          harness: "opencode",
          model: "anthropic/claude-x",
          agent: "build",
          permissionPolicy: "ask",
          description: "Default worker",
        },
      },
    },
    adapters: () => [
      new OpenCodeAdapter({
        connect: async () => ({ api: service.api, url: "http://fake" }),
        reconnectDelayMs: { min: 5, max: 20 },
      }),
    ],
    managerChannel: (adapters) => {
      const oc = adapters[0] as OpenCodeAdapter;
      return { wake: (id, text) => oc.wakeManager(id, text) };
    },
    notifier: new RecordingNotifier(),
    logger: createLogger({ level: "silent" }),
  });
}

describe("OpenCode vertical slice through the plugin tools", () => {
  it("dispatches, gates permissions on the human, survives a supervisor restart, and reports back", async () => {
    root = tempDir();
    const paths = testPaths(join(root, "home"));
    const managerDir = join(root, "manager");
    mkdirSync(managerDir);
    const service = new FakeOpenCodeService();
    const repoPath = makeRepo(root, "app");
    daemon = await boot(service, paths, repoPath);
    const human = new OcdClient({ socketPath: paths.socket, actor: "human" });

    const tools = new Map<string, OcdTool>(
      buildTools(
        (sessionId, directory) =>
          new OcdClient({ socketPath: paths.socket, actor: "manager", sessionId, directory }),
      ).map((t) => [t.name, t]),
    );
    const call = (
      name: string,
      input: unknown,
      sessionID = "ses_mgr",
      callID = `call_${Math.random()}`,
      directory = managerDir,
    ) => runTool(tools.get(name)!, input, { sessionID, callID, directory });

    expect(await call("list_tasks", {}, "ses_elsewhere", "c", root!)).toMatch(/not_manager/);
    expect(await call("list_tasks", {})).toMatch(/No matching tasks/);
    expect(await call("list_repos", {})).toMatch(/app \(default profile: oc\)/);
    expect(await call("list_repos", {})).toMatch(
      /oc: opencode anthropic\/claude-x agent=build, permissions=ask — Default worker/,
    );

    const dispatchInput = {
      repo: "app",
      title: "Fix bug",
      instructions: "Fix it",
      acceptance_criteria: ["tests pass"],
    };
    const first = await call("dispatch_task", dispatchInput, "ses_mgr", "call_1");
    const again = await call("dispatch_task", dispatchInput, "ses_mgr", "call_1");
    const taskId = /(t_\w+)/.exec(first)![1]!;
    expect(again).toMatch(new RegExp(`Already dispatched: ${taskId}`));

    // The worker session is created in the task's worktree and prompted once.
    await waitFor(
      () => service.calls.filter((c) => c.method === "session.prompt").length,
      (n) => n === 1,
    );
    const workerId = [...service.sessions.keys()][0]!;
    expect(service.sessions.get(workerId)!.directory).toBe(join(paths.workspaces, "app", taskId));
    expect(service.sessions.get(workerId)!.model).toEqual({
      providerID: "anthropic",
      id: "claude-x",
    });

    // Workers cannot use control tools even though the global plugin loads in their session.
    expect(await call("list_tasks", {}, workerId)).toMatch(/worker_session/);

    // Permissions go to the human; the manager cannot approve them.
    const perm = service.askPermission(workerId, "shell", ["npm publish"]);
    const blocked = await waitFor(
      () => human.inspectTask(taskId),
      (d) => d.task.state === "blocked",
    );
    const request = blocked.attention.find((a) => a.kind === "permission")!;
    expect(await call("resolve_attention", { id: request.id, response: "acknowledge" })).toMatch(
      /human_only/,
    );
    await human.resolveAttention(request.id, { type: "approve" });
    expect(service.calls.find((c) => c.method === "permission.reply")!.input).toMatchObject({
      requestID: perm,
      decision: "once",
    });
    await waitFor(
      () => human.inspectTask(taskId),
      (d) => d.task.state === "running",
    );

    // Restart the supervisor while the worker keeps running in the OpenCode service.
    const report = await daemon.stop();
    expect(report.workers[0]?.outcome).toMatch(/left running/);
    daemon = await boot(service, paths, repoPath);
    expect((await human.inspectTask(taskId)).task.state).toBe("running");
    expect(service.calls.filter((c) => c.method === "session.create")).toHaveLength(1);
    expect(service.calls.filter((c) => c.method === "session.prompt")).toHaveLength(1);

    // The worker finishes; the result is collected and the manager is woken.
    service.finish(
      workerId,
      'Fixed.\n```ocd-report\n{"summary":"Fixed the bug","changedFiles":[],"tests":[{"command":"npm test","outcome":"passed"}]}\n```',
    );
    const done = await waitFor(
      () => human.inspectTask(taskId),
      (d) => d.task.state === "ready_for_review",
    );
    expect(done.task.result?.reported?.tests[0]?.outcome).toBe("passed");
    expect(done.task.result?.verification?.changedFiles).toEqual([]);
    const wake = await waitFor(
      () => service.calls.filter((c) => c.method === "session.synthetic"),
      (calls) => calls.some((c) => JSON.stringify(c.input).includes("Ready for review")),
    );
    expect(wake.every((c) => (c.input as { sessionID: string }).sessionID === "ses_mgr")).toBe(
      true,
    );

    // A fresh or compacted manager context gets a bounded briefing; other sessions get nothing.
    const briefing = new BriefingCache(paths.socket, managerDir);
    expect(await briefing.forSession("ses_mgr")).toContain(taskId);
    expect(await briefing.forSession(workerId)).toBeNull();

    expect(await call("inspect_task", { id: taskId })).toContain("untrusted");
    expect(await call("accept_task", { id: taskId })).toMatch(/Accepted\. .* \[completed\]/);
  });
});
