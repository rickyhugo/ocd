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

  it("reports the account's usage limits from rate_limit_event, as percentages", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "spend [usage]");
    const limits = await until(
      () => events.flatMap((e) => (e.type === "limits" ? [e.usage] : [])),
      (l) => l.length > 0,
    );
    expect(limits[0]).toMatchObject({
      harness: "claude",
      state: "warning",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          short: "5h",
          usedPercent: 83,
          resetsAt: new Date(1792003800_000).toISOString(),
        },
        { id: "seven_day", label: "weekly", short: "wk", usedPercent: 63 },
      ],
    });
    // Account-wide, not a task event: the turn still completes normally.
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
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

  describe("a turn that ends while background work will continue it (#57)", () => {
    /** The final message each time the adapter reports idle: what the supervisor would review. */
    const idleMessages = (adapter: ClaudeAdapter, ref: { sessionId: string }) => {
      const texts: Promise<string | null>[] = [];
      adapter.subscribe((e) => {
        if (e.type === "status" && e.status === "idle")
          texts.push(adapter.inspect(ref).then((s) => s.lastAssistantText));
      });
      return () => Promise.all(texts);
    };

    it("yields while mapping subagents run, and goes idle only after the last turn", async () => {
      const { adapter, spec } = setup();
      const ref = await adapter.createSession(spec);
      const idle = idleMessages(adapter, ref);
      await adapter.prompt(ref, "plan [mapping]");
      await until(
        () => adapter.inspect(ref),
        (s) => s.status === "idle",
      );
      expect(await idle()).toEqual([expect.stringContaining("Both maps are in")]);
    });

    it("yields when a subagent finishes during the turn and its notice is not delivered yet", async () => {
      const { adapter, spec } = setup();
      const ref = await adapter.createSession(spec);
      const idle = idleMessages(adapter, ref);
      await adapter.prompt(ref, "check [finish-mid-turn]");
      await until(
        () => adapter.inspect(ref),
        (s) => s.status === "idle",
      );
      expect(await idle()).toEqual([expect.stringContaining("The check passed")]);
    });

    it("stays yielded while a scheduled wakeup has not fired", async () => {
      const { adapter, spec } = setup();
      const ref = await adapter.createSession(spec);
      await adapter.prompt(ref, "later [wakeup]");
      await until(
        () => adapter.inspect(ref),
        (s) => s.lastAssistantText === "Checking back in 20 minutes.",
      );
      await delay(200);
      expect((await adapter.inspect(ref)).status).toBe("yielded");
    });

    it("keeps a background subagent's permission request answerable after the turn ends", async () => {
      const { adapter, spec } = setup();
      const ref = await adapter.createSession(spec);
      await adapter.prompt(ref, "test [bg-perm]");
      const waiting = await until(
        () => adapter.inspect(ref),
        (s) => s.lastAssistantText === "Waiting on the test subagent.",
      );
      expect(waiting.status).toBe("waiting");
      expect(waiting.pending.map((p) => p.summary)).toEqual(["Bash: npm test"]);
      await adapter.reply(ref, waiting.pending[0]!.id, { type: "approve" });
      const done = await until(
        () => adapter.inspect(ref),
        (s) => s.status === "idle",
      );
      expect(done.lastAssistantText).toContain("Tests ran (allow)");
    });
  });

  it("reports the worker's task list from the stream as todos", async () => {
    const { adapter, events, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[todos]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
    );
    const reported = events.flatMap((e) => (e.type === "todos" ? [e.todos] : []));
    expect(reported.at(-1)).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Fix the bug", status: "in_progress" },
    ]);
    expect(JSON.stringify(reported)).not.toContain("Subagent");
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

  // Recorded from Claude Code 2.1.299: a message sent mid-turn is either run
  // as its own turn after the current one (two results) or folded into the
  // running turn (one result); the replay echo says which.
  it("stays busy across a result while a message sent mid-turn is still queued", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    const statuses: string[] = [];
    adapter.subscribe((e) => void (e.type === "status" && statuses.push(e.status)));
    await adapter.prompt(ref, "[queue]");
    await delay(50);
    await adapter.prompt(ref, "second");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle",
    );
    expect((await adapter.inspect(ref)).lastAssistantText).toContain("claude did it");
    expect(statuses.filter((s) => s === "idle")).toEqual(["idle"]);
  });

  it("goes idle after one result when a message sent mid-turn was folded into it", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[fold]");
    await delay(50);
    await adapter.prompt(ref, "second");
    const s = await until(
      () => adapter.inspect(ref),
      (x) => x.status === "idle",
    );
    expect(s.lastAssistantText).toContain("folded: second");
  });

  it("does not read an interrupted turn as a failure when a prompt follows at once", async () => {
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
    await adapter.prompt(ref, "after the interrupt");
    const s = await until(
      () => adapter.inspect(ref),
      (x) => x.status === "idle" && x.lastAssistantText !== null,
    );
    expect(s.error).toBeNull();
    expect(statuses).not.toContain("error");
  });

  it("fails fast when the binary cannot start", async () => {
    const { spec } = setup();
    adapter = new ClaudeAdapter({ command: ["/nonexistent/claude"] });
    await expect(adapter.createSession(spec)).rejects.toMatchObject({
      name: "HarnessUnavailableError",
    });
  });
});

describe("Claude Code worker lifecycle", () => {
  it("skips permission checks under yolo", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession({ ...spec, permissionPolicy: "yolo" });
    await adapter.prompt(ref, "[args]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.lastAssistantText).toContain("--dangerously-skip-permissions");
    expect(snap.lastAssistantText).not.toContain("--permission-mode");
    expect(snap.lastAssistantText).toContain("--permission-prompt-tool stdio");
  });

  it("stops idle workers and resumes them transparently on the next prompt", async () => {
    const { spec } = setup();
    await adapter!.close();
    adapter = new ClaudeAdapter({ command: [process.execPath, FAKE], idleStopMs: 100 });
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
    await adapter.prompt(ref, "[args]");
    const snap = await until(
      () => adapter!.inspect(ref),
      (s) => (s.lastAssistantText ?? "").startsWith("args:"),
    );
    expect(snap.lastAssistantText).toContain(`--resume ${ref.sessionId}`);
    expect(adapter.activeWorkers()).toBe(1);
  });

  it("releases a finished session's worker", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    expect(adapter.activeWorkers()).toBe(1);
    await adapter.release(ref);
    expect(adapter.activeWorkers()).toBe(0);
    expect((await adapter.inspect(ref)).status).toBe("missing");
  });
});

describe("Claude Code transcript", () => {
  const read = (a: ClaudeAdapter, sessionId: string, reasoningSummaries = false) =>
    a.transcript({ sessionId }, { limit: 50, before: null, reasoningSummaries });

  it("keeps visible text and tool calls with results, never thinking, prompts or partials", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    expect((await read(adapter, ref.sessionId))?.entries ?? []).toEqual([]);
    await adapter.prompt(ref, "secret instructions [transcript]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    const page = (await read(adapter, ref.sessionId, true))!;
    expect(page.source).toBe("live_buffer");
    expect(page.reasoningSummaries).toBe("unsupported");
    const visible = page.entries.filter((e) => e.text !== "working");
    expect(visible.map((e) => [e.kind, e.id])).toEqual([
      ["message", "u2:0"],
      ["tool", "tool:toolu_9"],
      ["message", "u7:0"],
    ]);
    expect(visible[1]!.tool).toMatchObject({
      name: "Bash",
      callId: "toolu_9",
      status: "completed",
      input: '{"command":"[REDACTED] npm test"}',
      output: "3 passed [REDACTED]",
    });
    const all = JSON.stringify(page);
    for (const hidden of [
      "PRIVATE-THOUGHT",
      "ENCRYPTED",
      "PARTIAL",
      "secret instructions",
      "abcdef123456",
    ])
      expect(all).not.toContain(hidden);
  });

  it("retains a released session's snapshot without restarting it, and has nothing after a restart", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[transcript]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    await adapter.release(ref);
    const retained = (await read(adapter, ref.sessionId))!;
    expect(retained.source).toBe("retained_buffer");
    expect(retained.entries.some((e) => e.text === "All tests pass")).toBe(true);
    expect(adapter.activeWorkers()).toBe(0);
    expect((await adapter.inspect(ref)).status).toBe("missing");

    // Another adapter instance (a supervisor restart) never saw it, and does not resume it to look.
    const fresh = new ClaudeAdapter({ command: [process.execPath, FAKE] });
    expect(await read(fresh, ref.sessionId)).toBeNull();
    expect(fresh.activeWorkers()).toBe(0);
    await fresh.close();
  });
});
