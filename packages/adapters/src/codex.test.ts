import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CodexAdapter, parseCodexModel } from "./codex.ts";
import type { AdapterEvent, SessionSpec } from "./types.ts";

const FAKE = join(import.meta.dirname, "..", "test-fixtures", "fake-codex-app-server.mjs");
let adapter: CodexAdapter | null = null;
let dir: string | null = null;
afterEach(async () => {
  await adapter?.close();
  adapter = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocd-codex-")));
  adapter = new CodexAdapter({ command: [process.execPath, FAKE] });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const spec: SessionSpec = {
    taskId: "t_1",
    runId: "w_1",
    marker: "ocd:t_1:w_1",
    title: "t",
    directory: dir,
    model: "gpt-5-codex#high",
    agent: null,
    permissionPolicy: "ask",
    env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"]!, ...env },
  };
  return { adapter, events, spec };
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await delay(10);
  }
}

describe("Codex adapter", () => {
  it("parses model#effort", () => {
    expect(parseCodexModel("gpt-5-codex#high")).toEqual({ model: "gpt-5-codex", effort: "high" });
    expect(parseCodexModel("gpt-5-codex")).toEqual({ model: "gpt-5-codex", effort: null });
  });

  it("runs a turn to completion and reports the final message", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    expect(await adapter.findSession(spec)).toEqual(ref);
    await adapter.prompt(ref, "do it");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.prompted).toBe(true);
    expect(snap.lastAssistantText).toContain("ocd-report");
  });

  it("forwards command and file approvals and answers them once", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[approve-cmd]");
    const waiting = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "waiting",
    );
    expect(waiting.pending[0]).toMatchObject({
      kind: "permission",
      summary: "shell: npm publish (network)",
      operation: { kind: "command", command: "npm publish" },
    });
    await adapter.reply(ref, waiting.pending[0]!.id, { type: "approve" });
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && (s.lastAssistantText ?? "").includes("Approved"),
    );
    expect(events.some((e) => e.type === "interaction_resolved")).toBe(true);

    await adapter.prompt(ref, "[edit]");
    const edit = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "waiting",
    );
    expect(edit.pending[0]?.summary).toBe("edit: src/a.ts (outside workspace)");
    await adapter.reply(ref, edit.pending[0]!.id, { type: "deny" });
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText === "Declined; stopping.",
    );
  });

  it("classifies usage limits as quota waits", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[limit]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "error",
    );
    expect(snap).toMatchObject({ quotaLimited: true, error: "Usage limit reached" });
  });

  it("interrupts a running turn and resumes a thread in a new process", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[hang]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "busy",
    );
    await adapter.interrupt(ref);
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
    );

    // Simulate the supervisor dying: a new adapter has no running process.
    const fresh = new CodexAdapter({ command: [process.execPath, FAKE] });
    expect((await fresh.inspect(ref)).status).toBe("missing");
    await fresh.revive(ref, spec);
    expect((await fresh.inspect(ref)).prompted).toBe(true);
    await fresh.prompt(ref, "continue");
    await until(
      () => fresh.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    await fresh.close();
  });

  it("refuses to start when Codex is not logged in", async () => {
    const { adapter, spec } = setup({ FAKE_CODEX_LOGGED_OUT: "1" });
    await expect(adapter.createSession(spec)).rejects.toMatchObject({
      name: "HarnessUnavailableError",
      message: expect.stringMatching(/codex login/),
    });
  });

  it("probes the version of the real binary interface", async () => {
    const status = await new CodexAdapter({
      command: ["/nonexistent/codex", "app-server"],
    }).probe();
    expect(status.available).toBe(false);
  });
});

describe("Codex worker lifecycle", () => {
  it("never asks and drops the sandbox under yolo", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession({ ...spec, permissionPolicy: "yolo" });
    await adapter.prompt(ref, "[params]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(JSON.parse(snap.lastAssistantText!)).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("stops idle app-servers and resumes the thread on the next prompt", async () => {
    const { spec } = setup();
    await adapter!.close();
    adapter = new CodexAdapter({ command: [process.execPath, FAKE], idleStopMs: 100 });
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "first");
    await until(
      () => adapter!.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    await until(
      () => adapter!.activeWorkers(),
      (n) => n === 0,
    );
    expect(await adapter.inspect(ref)).toMatchObject({ status: "idle", prompted: true });
    await adapter.prompt(ref, "[params]");
    const snap = await until(
      () => adapter!.inspect(ref),
      (s) => (s.lastAssistantText ?? "").includes("resumed"),
    );
    expect(JSON.parse(snap.lastAssistantText!)).toMatchObject({
      resumed: true,
      threadId: ref.sessionId,
    });
  });

  it("releases a finished session's worker", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.release(ref);
    expect(adapter.activeWorkers()).toBe(0);
    expect((await adapter.inspect(ref)).status).toBe("missing");
  });
});
