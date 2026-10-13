import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { OpenCodeAdapter, parseModel } from "./opencode.ts";
import { FakeOpenCodeService } from "./testing.ts";
import type { AdapterEvent, SessionSpec } from "./types.ts";

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
