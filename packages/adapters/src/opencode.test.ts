import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { OpenCodeAdapter, parseModel } from "./opencode.ts";
import { FakeOpenCodeService } from "./testing.ts";
import type { AdapterEvent, SessionSpec, TranscriptPage } from "./types.ts";

const spec: SessionSpec = {
  taskId: "t_1",
  runId: "w_1",
  marker: "ocd:t_1:w_1",
  title: "ocd:t_1:w_1 Fix the bug",
  directory: "/tmp/ws/app/t_1",
  model: "anthropic/claude-x#high",
  agent: "build",
  permissionPolicy: "ask",
  env: {},
  isolationEnv: { OCD_HOME: "/sandbox/t_1", OCD_SOCKET: "/sandbox/t_1/run/ocd.sock" },
};

let adapter: OpenCodeAdapter | null = null;
afterEach(async () => {
  await adapter?.close();
  adapter = null;
});

function setup(service = new FakeOpenCodeService()) {
  adapter = new OpenCodeAdapter({
    connect: async () => ({ api: service.api, url: "http://fake" }),
    reconnectDelayMs: { min: 5, max: 20 },
  });
  const events: AdapterEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  return { service, adapter, events };
}

async function until(fn: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await delay(5);
  }
}

describe("OpenCode adapter", () => {
  it("parses provider/model#variant and rejects bare model names", () => {
    expect(parseModel("anthropic/claude-x#high")).toEqual({
      providerID: "anthropic",
      id: "claude-x",
      variant: "high",
    });
    expect(parseModel("openrouter/vendor/model")).toEqual({
      providerID: "openrouter",
      id: "vendor/model",
    });
    expect(() => parseModel("claude-x")).toThrow();
  });

  it("probes the service version and flags untested versions", async () => {
    expect((await setup().adapter.probe()).problems).toEqual([]);
    const other = await setup(new FakeOpenCodeService("2.1.0")).adapter.probe();
    expect(other.available).toBe(true);
    expect(other.problems[0]).toMatch(/untested/);
  });

  it("isolates every worker session from the live OCD, also when adopting one after a crash", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    const env = service.calls.filter((c) => c.method === "session.environment");
    expect(env.map((c) => c.input)).toEqual([
      { sessionID: ref.sessionId, variables: spec.isolationEnv },
    ]);
    const methods = service.calls.map((c) => c.method);
    // Isolated before anything can prompt it.
    expect(methods.indexOf("session.environment")).toBeGreaterThan(
      methods.indexOf("session.create"),
    );
    expect(methods).not.toContain("session.prompt");
    await adapter.findSession(spec);
    expect(service.calls.filter((c) => c.method === "session.environment")).toHaveLength(2);
  });

  it("creates sessions in the workspace with a marker, model, and permission guard", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    const create = service.calls.find((c) => c.method === "session.create")!.input as Record<
      string,
      unknown
    >;
    expect(create).toMatchObject({
      title: spec.title,
      agent: "build",
      model: { providerID: "anthropic", id: "claude-x", variant: "high" },
      location: { directory: spec.directory },
      metadata: { ocdMarker: spec.marker, ocdTaskId: "t_1", ocdRunId: "w_1" },
      permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    });
    expect(await adapter.findSession(spec)).toEqual(ref);
    expect(await adapter.findSession({ ...spec, marker: "ocd:t_2:w_9" })).toBeNull();
  });

  it("maps session state, pending requests, and the final report", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    expect(await adapter.inspect(ref)).toMatchObject({ status: "idle", prompted: false });
    await adapter.prompt(ref, "do it");
    expect(await adapter.inspect(ref)).toMatchObject({ status: "busy", prompted: true });
    const perm = service.askPermission(ref.sessionId, "shell", ["git push"]);
    const waiting = await adapter.inspect(ref);
    expect(waiting.status).toBe("waiting");
    expect(waiting.pending[0]).toMatchObject({
      id: `perm:${perm}`,
      kind: "permission",
      summary: "shell git push",
    });
    await adapter.reply(ref, `perm:${perm}`, { type: "deny", message: "no" });
    expect(service.calls.at(-1)).toEqual({
      method: "permission.reply",
      input: { sessionID: ref.sessionId, requestID: perm, decision: "reject", message: "no" },
    });
    service.finish(ref.sessionId, "Done\n```ocd-report\n{}\n```");
    expect(await adapter.inspect(ref)).toMatchObject({
      status: "idle",
      lastAssistantText: "Done\n```ocd-report\n{}\n```",
    });
    expect((await adapter.inspect({ sessionId: "ses_missing" })).status).toBe("missing");
  });

  it("approves once, never always, and answers forms through their first text field", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    const perm = service.askPermission(ref.sessionId, "edit", ["a.ts"]);
    await adapter.reply(ref, `perm:${perm}`, { type: "approve" });
    expect((service.calls.at(-1)!.input as { decision: string }).decision).toBe("once");
    const form = service.askForm(ref.sessionId, "Which approach?");
    await adapter.reply(ref, `form:${form}`, { type: "answer", text: "simple" });
    expect(service.calls.at(-1)).toEqual({
      method: "session.form.reply",
      input: { sessionID: ref.sessionId, formID: form, answer: { answer: "simple" } },
    });
  });

  it("classifies usage limits as quota waits", async () => {
    const { service, adapter, events } = setup();
    const ref = await adapter.createSession(spec);
    service.fail(ref.sessionId, { type: "api", message: "Rate limit exceeded", status: 429 });
    await until(() => events.some((e) => e.type === "status" && e.status === "error"));
    expect(events.find((e) => e.type === "status" && e.status === "error")).toMatchObject({
      quotaLimited: true,
    });
    expect(await adapter.inspect(ref)).toMatchObject({ status: "error", quotaLimited: true });
  });

  it("forwards events only for tracked sessions and reconnects after the stream drops", async () => {
    const { service, adapter, events } = setup();
    await until(() => events.some((e) => e.type === "stream" && e.state === "connected"));
    service.emit("session.status", { sessionID: "ses_other", status: { type: "busy" } });
    const ref = await adapter.createSession(spec);
    service.askPermission(ref.sessionId, "shell", ["rm -rf /"]);
    await until(() => events.some((e) => e.type === "interaction"));
    expect(events.filter((e) => "sessionId" in e && e.sessionId === "ses_other")).toEqual([]);

    service.dropStreams();
    await until(
      () => events.filter((e) => e.type === "stream" && e.state === "connected").length === 2,
    );
    expect(events.some((e) => e.type === "stream" && e.state === "disconnected")).toBe(true);
  });

  it("marks text, reasoning and tool events as worker output, not session bookkeeping", async () => {
    const { service, adapter, events } = setup();
    await until(() => events.some((e) => e.type === "stream" && e.state === "connected"));
    const ref = await adapter.createSession(spec);
    const sessionID = ref.sessionId;
    for (const type of [
      "session.inbox.delivered",
      "session.step.started",
      "session.text.delta",
      "session.reasoning.started",
      "session.tool.called",
      "session.usage.updated",
    ])
      service.emit(type, { sessionID });
    await until(() => events.filter((e) => e.type === "activity").length === 6);
    expect(events.flatMap((e) => (e.type === "activity" ? [e.output === true] : []))).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("wakes the manager with a synthetic, queued input", async () => {
    const { service, adapter } = setup();
    await adapter.wakeManager("ses_mgr", "update");
    expect(service.calls.at(-1)).toEqual({
      method: "session.synthetic",
      input: {
        sessionID: "ses_mgr",
        text: "update",
        description: "OCD supervisor update",
        delivery: "queue",
        resume: true,
      },
    });
  });
});

describe("OpenCode prompt admission", () => {
  it("counts a prompt still waiting in the session inbox as admitted", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    expect((await adapter.inspect(ref)).prompted).toBe(false);
    service.inbox.set(ref.sessionId, [{ type: "user", id: "msg_queued" }]);
    expect((await adapter.inspect(ref)).prompted).toBe(true);
  });

  it("reports a refused connection as harness-unavailable", async () => {
    const { service, adapter } = setup();
    service.down = true;
    await expect(adapter.createSession(spec)).rejects.toMatchObject({
      name: "HarnessUnavailableError",
    });
  });
});

describe("OpenCode yolo", () => {
  it("creates sessions with an allow-all rule", async () => {
    const { service, adapter } = setup();
    await adapter.createSession({ ...spec, permissionPolicy: "yolo" });
    const create = service.calls.find((c) => c.method === "session.create")!.input as Record<
      string,
      unknown
    >;
    expect(create["permissions"]).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });
});

describe("OpenCode transcript", () => {
  function assistant(service: FakeOpenCodeService, sessionID: string, n: number) {
    return service.addMessage(sessionID, {
      type: "assistant",
      time: { created: 1_000 * n },
      content: [{ type: "text", text: `step ${n}` }],
    });
  }

  it("reads visible history read-only: text and tools, no prompts or reasoning", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "secret instructions");
    service.addMessage(ref.sessionId, { type: "synthetic", text: "OCD internal note" });
    service.addMessage(ref.sessionId, {
      type: "assistant",
      time: { created: 5_000 },
      content: [
        { type: "reasoning", text: "RAW-REASONING" },
        { type: "text", text: "Running tests" },
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          time: { created: 6_000 },
          state: {
            status: "completed",
            input: { command: "npm test", password: "hunter22" },
            content: [{ type: "text", text: "1 passed" }],
          },
        },
        {
          type: "tool",
          id: "call_2",
          name: "read",
          time: { created: 7_000 },
          state: { status: "error", input: {}, error: { type: "x", message: "ENOENT" } },
        },
      ],
      error: { type: "provider", message: "overloaded" },
    });
    service.addMessage(ref.sessionId, {
      type: "shell",
      shellID: "sh_1",
      command: "ls",
      status: "exited",
      exit: 0,
      output: { output: "a.ts", cursor: 0, size: 4, truncated: false },
    });
    const before = service.calls.length;
    const page = (await adapter.transcript(ref, {
      limit: 30,
      before: null,
      reasoningSummaries: true,
    }))!;
    // Only message.list was called: nothing created, prompted, resumed or interrupted.
    expect(service.calls.slice(before).map((c) => c.method)).toEqual(["message.list"]);
    expect(page.source).toBe("native_history");
    expect(page.reasoningSummaries).toBe("unsupported");
    expect(page.entries.map((e) => [e.kind, e.text ?? e.tool!.name])).toEqual([
      ["message", "Running tests"],
      ["tool", "bash"],
      ["tool", "read"],
      ["message", "Error: overloaded"],
      ["tool", "shell"],
    ]);
    expect(page.entries[1]).toMatchObject({
      id: "tool:call_1",
      at: new Date(6_000).toISOString(),
      tool: { status: "completed", output: "1 passed" },
    });
    expect(page.entries[1]!.tool!.input).toContain('"password":"[REDACTED]"');
    expect(page.entries[2]!.tool).toMatchObject({ status: "error", output: "ENOENT" });
    expect(page.entries[4]!.tool).toMatchObject({ input: "ls", output: "a.ts\n[exit 0]" });
    const all = JSON.stringify(page);
    for (const hidden of ["RAW-REASONING", "secret instructions", "OCD internal note", "hunter22"])
      expect(all).not.toContain(hidden);
  });

  it("pages back through the whole history with stable, non-overlapping pages", async () => {
    const { service, adapter } = setup();
    const ref = await adapter.createSession(spec);
    for (let n = 1; n <= 120; n++) assistant(service, ref.sessionId, n);
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: TranscriptPage = (await adapter.transcript(ref, {
        limit: 40,
        before,
        reasoningSummaries: false,
      }))!;
      seen.unshift(...page.entries.map((e) => e.text!));
      before = page.before;
      if (!before) break;
      // New activity between pages does not shift or repeat what is returned.
      if (i === 0) assistant(service, ref.sessionId, 999);
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `step ${i + 1}`));
    await expect(
      adapter.transcript(ref, { limit: 5, before: "garbage", reasoningSummaries: false }),
    ).rejects.toMatchObject({ name: "InvalidCursorError" });
  });

  it("returns null for a session the service no longer has", async () => {
    const { adapter } = setup();
    expect(
      await adapter.transcript(
        { sessionId: "ses_gone" },
        { limit: 5, before: null, reasoningSummaries: false },
      ),
    ).toBeNull();
  });
});
