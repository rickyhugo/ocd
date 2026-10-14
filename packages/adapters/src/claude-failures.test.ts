import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ClaudeAdapter } from "./claude.ts";
import { ClaudeTodoTracker, type ClaudeStreamMessage } from "./claude-todos.ts";
import type { SessionSpec } from "./types.ts";

const FAKE = join(import.meta.dirname, "..", "test-fixtures", "fake-claude.mjs");
let adapter: ClaudeAdapter | null = null;
let dir: string | null = null;
afterEach(async () => {
  await adapter?.close();
  adapter = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocd-claude-")));
  adapter = new ClaudeAdapter({ command: [process.execPath, FAKE] });
  const spec: SessionSpec = {
    taskId: "t_1",
    runId: "w_1",
    marker: "ocd:t_1:w_1",
    title: "t",
    directory: dir,
    model: "sonnet#high",
    agent: null,
    permissionPolicy: "ask",
    isolationEnv: { OCD_HOME: "/sandbox/t_1" },
    env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"]! },
  };
  return { adapter, spec };
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

describe("Claude Code worker failures", () => {
  it("forgets the marker of a session that failed to start", async () => {
    const { spec } = setup();
    adapter = new ClaudeAdapter({ command: ["/nonexistent/claude"] });
    await expect(adapter.createSession(spec)).rejects.toThrow();
    expect(await adapter.findSession(spec)).toBeNull();
  });

  it("drops pending requests when the process dies", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[perm-die]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "error",
    );
    expect(snap.pending).toEqual([]);
  });

  it("restarts instead of dropping a prompt that arrives while an idle worker is stopping", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "first");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      park(session: unknown): Promise<void>;
    };
    const parking = internals.park(internals.sessions.get(ref.sessionId));
    await adapter.prompt(ref, "[args] second");
    await parking;
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && (s.lastAssistantText ?? "").includes("--resume"),
    );
    expect(snap.error).toBeNull();
  });
});

describe("ClaudeTodoTracker malformed input", () => {
  it("ignores messages and blocks of the wrong shape", () => {
    const tracker = new ClaudeTodoTracker();
    const junk = [
      null,
      { type: "assistant" },
      { type: "assistant", message: null },
      { type: "assistant", message: "text" },
      { type: "assistant", message: { content: [null, 5, { type: "tool_use", id: 7 }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: {} }] } },
      { type: "user", message: { content: "x" }, tool_use_result: null },
    ] as unknown as ClaudeStreamMessage[];
    for (const message of junk) expect(tracker.observe(message)).toBeNull();
  });
});
