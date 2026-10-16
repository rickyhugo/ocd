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
    isolationEnv: { OCD_HOME: "/sandbox/t_1" },
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

  it("reports the account's usage limits on start and on change, and reads them without a thread", async () => {
    const { adapter, events, spec } = setup();
    const limits = () => events.flatMap((e) => (e.type === "limits" ? [e.usage] : []));
    const ref = await adapter.createSession(spec);
    await until(limits, (l) => l.length > 0);
    expect(limits()[0]).toMatchObject({
      harness: "codex",
      state: "ok",
      plan: "pro",
      windows: [
        {
          id: "codex:10080",
          label: "weekly",
          short: "wk",
          usedPercent: 22,
          resetsAt: new Date(1792477564_000).toISOString(),
        },
      ],
    });
    // account/rateLimits/updated is sparse; the adapter re-reads the snapshot.
    await adapter.prompt(ref, "spend [usage]");
    await until(
      () => limits().at(-1)?.windows[0]?.usedPercent,
      (v) => v === 85,
    );
    expect(limits().at(-1)?.plan).toBe("pro");

    // A short-lived app-server: no thread, no model call.
    const read = await adapter.readLimits();
    expect(read).toMatchObject({ harness: "codex", windows: [{ usedPercent: 22 }] });
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

  it("marks the agent's items as worker output, never the userMessage item echoing the prompt", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[transcript]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
    );
    const output = events.flatMap((e) => (e.type === "activity" ? [e.output === true] : []));
    // userMessage started and completed, a reasoning delta, then agent items with one
    // message delta among them (deltas stay unmarked), then the final message
    expect(output).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("reports plan updates as the checklist, without the explanation", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[plan] do it");
    const todos = await until(
      () => events.find((e) => e.type === "todos"),
      (e) => e !== undefined,
    );
    expect(todos).toEqual({
      type: "todos",
      sessionId: ref.sessionId,
      todos: [
        { text: "Inspect the adapter", status: "completed" },
        { text: "Add the handler", status: "in_progress" },
        { text: "Write tests", status: "pending" },
      ],
    });
    expect(JSON.stringify(events)).not.toContain("narration");
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

  // Recorded from codex 0.162.1: turn/interrupt is acknowledged before the turn
  // completes, and steering a turn that already ended is refused.
  it("starts a new turn for a prompt sent right after an interrupt", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    const statuses: string[] = [];
    adapter.subscribe((e) => void (e.type === "status" && statuses.push(e.status)));
    await adapter.prompt(ref, "[hang]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "busy",
    );
    await adapter.interrupt(ref);
    expect((await adapter.inspect(ref)).status).toBe("idle");
    await adapter.prompt(ref, "after the interrupt");
    const s = await until(
      () => adapter.inspect(ref),
      (x) => x.status === "idle" && x.lastAssistantText !== null,
    );
    expect(s.error).toBeNull();
    expect(statuses).not.toContain("error");
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

describe("Codex turn ordering", () => {
  it("ends idle when a turn completes before its turn/start reply arrives", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[early] quick");
    const snap = await adapter.inspect(ref);
    expect(snap.status).toBe("idle");
    expect(snap.lastAssistantText).toContain("ocd-report");
    await adapter.prompt(ref, "[early] again");
    expect((await adapter.inspect(ref)).status).toBe("idle");
  });
});

describe("Codex transcript", () => {
  it("keeps completed items and opt-in reasoning summaries, never raw reasoning or prompts", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "secret instructions [transcript]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    const read = (reasoningSummaries: boolean) =>
      adapter.transcript(ref, { limit: 50, before: null, reasoningSummaries });

    const plain = (await read(false))!;
    expect(plain.reasoningSummaries).toBe("excluded");
    expect(plain.entries.map((e) => e.id)).toEqual(["m_1", "c_1", "f_1", "x_1", "msg_turn_1"]);
    const [message, command, edit, mcp] = plain.entries;
    expect(message!.at).toBe(new Date(3000).toISOString());
    // The completed command keeps its start time, is not duplicated, and is redacted.
    expect(command).toMatchObject({
      at: new Date(4000).toISOString(),
      tool: {
        name: "shell",
        status: "completed",
        input: "npm test",
        output: "ok [REDACTED]\n[exit 0]",
      },
    });
    expect(edit!.tool).toMatchObject({
      name: "edit",
      input: '[{"path":"src/a.ts","kind":"update"}]',
    });
    expect(mcp!.tool).toMatchObject({ name: "mcp:docs/search", status: "error", output: "boom" });

    const withSummaries = (await read(true))!;
    expect(withSummaries.reasoningSummaries).toBe("included");
    expect(withSummaries.entries[0]).toMatchObject({
      kind: "reasoning_summary",
      text: "Checked the failing test",
    });
    // Reasoning without a summary produces nothing.
    expect(withSummaries.entries.filter((e) => e.kind === "reasoning_summary")).toHaveLength(1);
    const all = JSON.stringify(withSummaries);
    for (const hidden of ["RAW-", "PARTIAL", "secret instructions", "DIFF-BODY", "AKIA"])
      expect(all).not.toContain(hidden);
  });

  it("pages older entries with the adapter cursor", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[transcript]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    const latest = (await adapter.transcript(ref, {
      limit: 2,
      before: null,
      reasoningSummaries: false,
    }))!;
    expect(latest.entries.map((e) => e.id)).toEqual(["x_1", "msg_turn_1"]);
    const older = (await adapter.transcript(ref, {
      limit: 2,
      before: latest.before,
      reasoningSummaries: false,
    }))!;
    expect(older.entries.map((e) => e.id)).toEqual(["c_1", "f_1"]);
    await adapter.release(ref);
    expect(
      (await adapter.transcript(ref, { limit: 2, before: null, reasoningSummaries: false }))!
        .source,
    ).toBe("retained_buffer");
  });
});
