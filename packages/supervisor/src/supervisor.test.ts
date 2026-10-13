import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OcdApiError, OcdClient } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  declareRepos,
  makeRepo,
  startHarness,
  setupRepo,
  waitFor,
  waitForState,
  type Harness,
} from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const dispatch = (
  client: OcdClient,
  repo: string,
  instructions: string,
  key = `key-${Math.random()}`,
) =>
  client.dispatch({
    repo,
    title: `Task in ${repo}`,
    instructions,
    idempotencyKey: key,
    acceptanceCriteria: ["It works"],
  });

describe("dispatch and review", () => {
  it("runs a task to ready_for_review with a report and independent verification; the manager can accept it", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "Write the file");
    const detail = await waitForState(h, task.id, "ready_for_review");

    expect(detail.task.result?.reported?.summary).toBe("Wrote ocd-fake.txt");
    expect(detail.task.result?.verification?.changedFiles).toEqual(["ocd-fake.txt"]);
    expect(detail.task.workspacePath).toBe(join(h.paths.workspaces, "app", task.id));
    expect(detail.attention.find((a) => a.kind === "review")?.status).toBe("open");

    await expect(h.manager("outsider", h.root).acceptTask(task.id)).rejects.toMatchObject({
      code: "not_manager",
    });
    const done = await h.manager("mgr-session").acceptTask(task.id);
    expect(done.state).toBe("completed");
    const accepted = await h.human.inspectTask(task.id);
    expect(accepted.attention.find((a) => a.kind === "review")).toMatchObject({
      status: "resolved",
      resolvedBy: "manager",
    });
    expect(accepted.events.find((e) => e.type === "task.accepted")?.data).toMatchObject({
      data: { actor: "manager" },
    });
  });

  it("dispatches to two repositories without changing the supervisor's cwd (AT1)", async () => {
    h = await startHarness();
    await setupRepo(h, "alpha");
    await setupRepo(h, "beta");
    const cwd = process.cwd();
    const a = await dispatch(h.human, "alpha", "one");
    const b = await dispatch(h.human, "beta", "two");
    const da = await waitForState(h, a.task.id, "ready_for_review");
    const db = await waitForState(h, b.task.id, "ready_for_review");
    expect(process.cwd()).toBe(cwd);
    expect(da.task.workspacePath).toContain(join("alpha", a.task.id));
    expect(db.task.workspacePath).toContain(join("beta", b.task.id));
    expect(da.task.branch).toBe(`ocd/${a.task.id}`);
  });

  it("rejects unsupported harness choices (AT2)", async () => {
    h = await startHarness({
      config: { profiles: { "codex-default": { harness: "codex", model: "gpt-x" } } },
    });
    await setupRepo(h, "app");
    await expect(
      h.human.dispatch({
        repo: "app",
        profile: "codex-default",
        title: "t",
        instructions: "i",
        idempotencyKey: "k-12345678",
      }),
    ).rejects.toMatchObject({ code: "harness_unsupported" });
    await expect(
      h.human.dispatch({
        repo: "app",
        profile: "missing",
        title: "t",
        instructions: "i",
        idempotencyKey: "k-87654321",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not launch duplicate workers for duplicate dispatch requests (AT3)", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const first = await dispatch(h.human, "app", "same", "dup-key-1");
    const second = await dispatch(h.human, "app", "same", "dup-key-1");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    await waitForState(h, first.task.id, "ready_for_review");
    expect(h.fakeState.createdCount).toBe(1);
    await expect(dispatch(h.human, "app", "different", "dup-key-1")).rejects.toMatchObject({
      code: "idempotency_mismatch",
    });
  });

  it("never treats idle without a valid report as completion (AT10)", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "go [fake:no-report]");
    const detail = await waitForState(h, task.id, "needs_attention");
    expect(detail.task.result?.reportError).toMatch(/No ocd-report/);
    expect(detail.task.result?.verification?.changedFiles).toEqual(["ocd-fake.txt"]);
  });

  it("respects serial capacity and dependencies", async () => {
    h = await startHarness({
      fake: {
        script: () => [
          { type: "wait", ms: 150 },
          { type: "reply", text: '```ocd-report\n{"summary":"ok"}\n```' },
        ],
      },
    });
    await setupRepo(h, "app");
    const a = await dispatch(h.human, "app", "a");
    const b = await h.human.dispatch({
      repo: "app",
      title: "b",
      instructions: "b",
      idempotencyKey: "dep-b-123",
      dependsOn: [a.task.id],
    });
    const c = await dispatch(h.human, "app", "c");
    await waitFor(
      () => h.human.inspectTask(a.task.id),
      (d) => d.task.state === "running",
    );
    expect((await h.human.inspectTask(c.task.id)).task.state).toBe("queued");
    await waitForState(h, c.task.id, "ready_for_review");
    // b waits for a to be accepted, not merely reviewed.
    await waitForState(h, a.task.id, "ready_for_review");
    expect((await h.human.inspectTask(b.task.id)).task.state).toBe("queued");
    await h.human.acceptTask(a.task.id);
    await waitForState(h, b.task.id, "ready_for_review");
  });

  it("pauses new dispatch without stopping running workers", async () => {
    h = await startHarness({
      fake: {
        script: () => [
          { type: "wait", ms: 100 },
          { type: "reply", text: '```ocd-report\n{"summary":"ok"}\n```' },
        ],
      },
    });
    await setupRepo(h, "app");
    const a = await dispatch(h.human, "app", "a");
    await waitForState(h, a.task.id, "running");
    await h.human.pause();
    const b = await dispatch(h.human, "app", "b");
    await waitForState(h, a.task.id, "ready_for_review");
    await new Promise((r) => setTimeout(r, 100));
    expect((await h.human.inspectTask(b.task.id)).task.state).toBe("queued");
    await h.human.resume();
    await waitForState(h, b.task.id, "ready_for_review");
  });
});

describe("permissions and interactions", () => {
  it("blocks on a permission, refuses manager self-approval, and continues after a human approves (AT7, AT8)", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.manager("mgr"), "app", "go [fake:permission]");
    const blocked = await waitForState(h, task.id, "blocked");
    const request = blocked.attention.find((a) => a.kind === "permission")!;
    expect(request.resolvableBy).toBe("human");
    expect(request.operation).toEqual({ tool: "bash", command: "rm -rf build" });

    await expect(
      h.manager("mgr").resolveAttention(request.id, { type: "approve" }),
    ).rejects.toMatchObject({ code: "human_only" });
    await h.human.resolveAttention(request.id, { type: "approve" });
    await waitForState(h, task.id, "ready_for_review");
    await expect(h.human.resolveAttention(request.id, { type: "approve" })).rejects.toMatchObject({
      code: "not_open",
    });
  });

  it("denies permissions under a deny profile and surfaces the block", async () => {
    h = await startHarness({
      config: {
        profiles: { strict: { harness: "fake", model: "fake/model", permissionPolicy: "deny" } },
      },
    });
    await setupRepo(h, "app", "strict");
    const { task } = await dispatch(h.human, "app", "go [fake:permission]");
    const detail = await waitForState(h, task.id, "needs_attention");
    const denied = detail.attention.find((a) => a.kind === "permission");
    expect(denied?.status).toBe("rejected");
    expect(detail.task.result?.finalMessageExcerpt).toMatch(/denied/);
  });

  it("lets the manager answer worker questions", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "go [fake:question]");
    const blocked = await waitForState(h, task.id, "blocked");
    const q = blocked.attention.find((a) => a.kind === "question")!;
    await h.manager("mgr").resolveAttention(q.id, { type: "answer", text: "Use the simple one" });
    await waitForState(h, task.id, "ready_for_review");
  });

  it("refuses stale approvals once the originating request is gone (AT8)", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "go [fake:permission]");
    const blocked = await waitForState(h, task.id, "blocked");
    const request = blocked.attention.find((a) => a.kind === "permission")!;
    // The harness loses the request (e.g. reload) without telling us.
    const session = h.fakeState.sessions.get(blocked.task.sessionId!)!;
    session.pending.clear();
    await expect(h.human.resolveAttention(request.id, { type: "approve" })).rejects.toMatchObject({
      code: "stale_request",
    });
    expect(
      (await h.human.inspectTask(task.id)).attention.find((a) => a.id === request.id)?.status,
    ).toBe("expired");
  });

  it("classifies quota limits as blocked, not success or failure (AT7)", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "go [fake:quota]");
    const detail = await waitForState(h, task.id, "blocked");
    expect(detail.attention.some((a) => a.reason.includes("usage limit"))).toBe(true);
    expect(detail.task.result).toBeNull();
  });
});

describe("cancellation and shutdown", () => {
  it("cancels without deleting the workspace (AT11)", async () => {
    h = await startHarness({
      fake: {
        script: () => [{ type: "write", file: "wip.txt", content: "wip" }, { type: "hang" }],
      },
    });
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "work");
    const running = await waitFor(
      () => h.human.inspectTask(task.id),
      (d) =>
        d.task.state === "running" &&
        d.task.workspacePath !== null &&
        existsSync(join(d.task.workspacePath, "wip.txt")),
    );
    const cancelled = await h.human.cancelTask(task.id, "changed my mind");
    expect(cancelled.state).toBe("cancelled");
    expect(readFileSync(join(running.task.workspacePath!, "wip.txt"), "utf8")).toBe("wip");
  });

  it("reports what happened to workers on graceful shutdown (AT11)", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "work");
    await waitForState(h, task.id, "running");
    const report = await h.human.shutdown();
    expect(report.workers).toEqual([
      expect.objectContaining({ taskId: task.id, outcome: expect.stringMatching(/interrupted/) }),
    ]);
    await h.daemon.closed;
    await h.restart();
    const detail = await h.human.inspectTask(task.id);
    expect(detail.task.state).toBe("interrupted");
    expect(detail.task.sessionId).not.toBeNull();
  });
});

describe("API boundaries", () => {
  it("rejects incompatible API versions", async () => {
    h = await startHarness();
    const raw = new OcdClient({ socketPath: h.paths.socket, actor: "human" });
    // Monkeypatch the version header by calling with a custom header set.
    const res = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request(
          {
            socketPath: h.paths.socket,
            path: "/v1/status",
            headers: { "x-ocd-api-version": "999", "x-ocd-actor": "human" },
          },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      }, reject);
    });
    expect(res).toBe(400);
    expect((await raw.status()).apiVersion).toBe(1);
  });

  it("restricts control tools to sessions in the manager directory and blocks worker sessions", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    await expect(h.manager("elsewhere", h.root).listTasks()).rejects.toMatchObject({
      code: "not_manager",
    });
    await expect(
      new OcdClient({ socketPath: h.paths.socket, actor: "manager", sessionId: "s" }).listTasks(),
    ).rejects.toMatchObject({
      code: "not_manager",
    });
    expect((await h.human.getManager()).active).toBeNull();

    // Any session in the manager directory may act; the latest one receives updates.
    const { task } = await dispatch(h.manager("mgr-1"), "app", "work");
    expect((await h.human.getManager()).active?.sessionId).toBe("mgr-1");
    await h.manager("mgr-2").listTasks();
    expect((await h.human.getManager()).active?.sessionId).toBe("mgr-2");

    const running = await waitForState(h, task.id, "running");
    const worker = h.manager(running.task.sessionId!);
    await expect(worker.listTasks()).rejects.toMatchObject({ code: "worker_session" });
    await expect(
      worker.dispatch({ repo: "app", title: "x", instructions: "y", idempotencyKey: "worker-123" }),
    ).rejects.toBeInstanceOf(OcdApiError);
  });

  it("refuses manager calls when no manager directory is configured", async () => {
    h = await startHarness({ config: { manager: undefined } });
    await expect(h.manager("mgr").listTasks()).rejects.toMatchObject({ code: "no_manager" });
    expect(await h.human.getManager()).toEqual({ directory: null, active: null });
  });

  it("declares repositories in ocd.jsonc and rejects invalid declarations", async () => {
    h = await startHarness();
    await expect(declareRepos(h, { x: { path: h.root } })).rejects.toThrow(
      /repos\.x\.path: .* is not a git repository/,
    );
    const path = makeRepo(h.root, "real");
    writeFileSync(h.paths.config, "{}");
    await expect(declareRepos(h, { real: { path, profile: "missing" } })).rejects.toThrow(
      /Profile "missing" is not declared/,
    );
    writeFileSync(h.paths.config, "{}");
    await declareRepos(h, { real: { path } });
    await expect(declareRepos(h, { twin: { path } })).rejects.toThrow(/already declared as real/);
  });

  it("retires repositories removed from ocd.jsonc but keeps their task history", async () => {
    h = await startHarness();
    const path = await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "x");
    await waitForState(h, task.id, "ready_for_review");
    writeFileSync(h.paths.config, JSON.stringify({ repos: {} }));
    await h.daemon.reload();
    expect(await h.human.listRepos()).toEqual([]);
    await expect(dispatch(h.human, "app", "y")).rejects.toMatchObject({ code: "not_found" });
    expect((await h.human.inspectTask(task.id)).task.repo).toBe("app");

    // Declaring the same path again, even under a new name, reuses the row.
    await declareRepos(h, { renamed: { path } });
    expect((await h.human.inspectTask(task.id)).task.repo).toBe("renamed");
  });
});

describe("allow permission policy", () => {
  it("approves each request once without blocking, and records it", async () => {
    h = await startHarness({
      config: {
        profiles: { open: { harness: "fake", model: "fake/model", permissionPolicy: "allow" } },
      },
    });
    await setupRepo(h, "app", "open");
    const { task } = await dispatch(h.human, "app", "go [fake:permission]");
    const detail = await waitForState(h, task.id, "ready_for_review");
    expect(detail.events.some((e) => e.type === "state.blocked")).toBe(false);
    const record = detail.attention.find((a) => a.kind === "permission");
    expect(record).toMatchObject({ status: "resolved", response: { type: "approve" } });
    expect(record?.reason).toMatch(/auto-approved/);
    expect(h.notifier.sent.some((n) => n.body.includes("auto-approved"))).toBe(false);
  });
});

describe("independent verification", () => {
  it("reports modified, added, renamed, and committed files exactly", async () => {
    h = await startHarness({
      fake: {
        script: () => [
          { type: "write", file: "README.md", content: "# changed\n" },
          { type: "write", file: "dir with space/new file.txt", content: "x" },
          { type: "reply", text: '```ocd-report\n{"summary":"ok"}\n```' },
        ],
      },
    });
    await setupRepo(h, "app");
    const { task } = await dispatch(h.human, "app", "edit");
    const detail = await waitForState(h, task.id, "ready_for_review");
    expect(detail.task.result?.verification).toEqual({
      changedFiles: ["README.md", "dir with space/new file.txt"],
      dirty: true,
      commitsAhead: 0,
    });
  });
});

describe("concurrency", () => {
  it("runs workers in parallel up to the configured limit, each in its own worktree", async () => {
    h = await startHarness({
      config: { concurrency: 2 },
      fake: {
        script: () => [
          { type: "write", file: "out.txt", content: "x" },
          { type: "wait", ms: 200 },
          { type: "reply", text: '```ocd-report\n{"summary":"ok"}\n```' },
        ],
      },
    });
    await setupRepo(h, "app");
    const ids = [];
    for (const n of [1, 2, 3]) ids.push((await dispatch(h.human, "app", `task ${n}`)).task.id);
    const live = await waitFor(
      () => h.human.listTasks({ state: ["running", "starting"] }),
      (tasks) => tasks.length === 2,
    );
    expect(new Set(live.map((t) => t.workspacePath)).size).toBe(2);
    expect((await h.human.inspectTask(ids[2]!)).task.state).toBe("queued");
    for (const id of ids) await waitForState(h, id, "ready_for_review");
  });
});

describe("yolo permission policy", () => {
  it("approves anything the harness still asks, without inbox records", async () => {
    h = await startHarness({
      config: {
        profiles: { wild: { harness: "fake", model: "fake/model", permissionPolicy: "yolo" } },
      },
    });
    await setupRepo(h, "app", "wild");
    const { task } = await dispatch(h.human, "app", "go [fake:permission]");
    const detail = await waitForState(h, task.id, "ready_for_review");
    expect(detail.attention.filter((a) => a.kind === "permission")).toEqual([]);
    expect(detail.events.some((e) => e.type === "permission.yolo_approved")).toBe(true);
    expect(detail.events.some((e) => e.type === "state.blocked")).toBe(false);
  });
});
