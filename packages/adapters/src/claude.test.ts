import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ClaudeAdapter, parseClaudeModel } from "./claude.ts";
import type { AdapterEvent, SessionSpec } from "./types.ts";

const FAKE = join(import.meta.dirname, "..", "test-fixtures", "fake-claude.mjs");
let adapter: ClaudeAdapter | null = null;
let dir: string | null = null;
afterEach(async () => {
  await adapter?.close();
  adapter = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocd-claude-")));
  adapter = new ClaudeAdapter({ command: [process.execPath, FAKE] });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const spec: SessionSpec = {
    taskId: "t_1",
    runId: "w_1",
    marker: "ocd:t_1:w_1",
    title: "t",
    directory: dir,
    model: "sonnet#high",
    agent: null,
    permissionPolicy: "ask",
    env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"]!, ...env },
  };
  return { adapter, events, spec };
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await delay(10);
  }
}

describe("Claude Code adapter", () => {
  it("parses model#effort", () => {
    expect(parseClaudeModel("opus#max")).toEqual({ model: "opus", effort: "max" });
    expect(parseClaudeModel("claude-sonnet-4-5")).toEqual({
      model: "claude-sonnet-4-5",
      effort: null,
    });
  });

  it("probes version and login", async () => {
    expect(await new ClaudeAdapter({ command: [process.execPath, FAKE] }).probe()).toMatchObject({
      available: true,
      version: "2.1.296",
      problems: [],
    });
    expect((await new ClaudeAdapter({ command: ["/nonexistent/claude"] }).probe()).available).toBe(
      false,
    );
  });

  it("runs turns with a caller-chosen session id and reports the result", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    expect(ref.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await adapter.inspect(ref)).prompted).toBe(false);
    await adapter.prompt(ref, "do it");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.lastAssistantText).toContain("Done (effort high)");
    await adapter.prompt(ref, "again");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
    );
  });

  it("forwards can_use_tool requests and answers them", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[perm]");
    const waiting = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "waiting",
    );
    expect(waiting.pending[0]).toMatchObject({
      kind: "permission",
      summary: "Bash: npm publish",
      operation: { tool: "Bash", input: { command: "npm publish" } },
    });
    await adapter.reply(ref, waiting.pending[0]!.id, { type: "approve" });
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && (s.lastAssistantText ?? "").startsWith("Ran npm publish"),
    );
    expect(events.some((e) => e.type === "interaction_resolved")).toBe(true);

    await adapter.prompt(ref, "[perm]");
    const again = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "waiting",
    );
    await adapter.reply(ref, again.pending[0]!.id, { type: "deny", message: "no publishing" });
    await until(
      () => adapter.inspect(ref),
      (s) => s.lastAssistantText === "Denied: no publishing",
    );
  });

  it("classifies usage limits as quota waits", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[limit]");
    expect(
      await until(
        () => adapter.inspect(ref),
        (s) => s.status === "error",
      ),
    ).toMatchObject({ quotaLimited: true });
  });

  it("interrupts a turn and resumes the session in a new process", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[hang]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "busy",
    );
    await adapter.interrupt(ref);
    await delay(100);
    expect((await adapter.inspect(ref)).status).toBe("idle");

    const fresh = new ClaudeAdapter({ command: [process.execPath, FAKE] });
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

  it("fails fast when the binary cannot start", async () => {
    const { spec } = setup();
    adapter = new ClaudeAdapter({ command: ["/nonexistent/claude"] });
    await expect(adapter.createSession(spec)).rejects.toMatchObject({
      name: "HarnessUnavailableError",
    });
  });
});
