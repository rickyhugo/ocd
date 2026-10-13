import type { OpenCodeEvent } from "@opencode/client";

import type { OpenCodeApi } from "./opencode.ts";

export { FakeAdapter, FakeHarnessState, defaultFakeScript, fakeReport } from "./fake.ts";

// An in-memory stand-in for the OpenCode V2 service, shaped like the subset of
// the real client OCD uses. Tests drive "workers" through its control methods.

interface FakeSession {
  id: string;
  title: string;
  directory: string;
  metadata: Record<string, unknown>;
  model: { providerID: string; id: string };
  agent: string | null;
  permissions: unknown[];
  messages: Array<Record<string, unknown>>;
  outcome?: "succeeded" | "failed" | "interrupted";
}

interface Pending {
  permissions: Map<
    string,
    { id: string; sessionID: string; action: string; resources: string[]; message?: string }
  >;
  forms: Map<
    string,
    { id: string; sessionID: string; title: string; fields: Array<{ key: string; type: string }> }
  >;
}

type Listener = (event: OpenCodeEvent | null) => void;

export class FakeOpenCodeService {
  readonly version: string;
  readonly sessions = new Map<string, FakeSession>();
  readonly active = new Set<string>();
  readonly pending: Pending = { permissions: new Map(), forms: new Map() };
  readonly calls: { method: string; input: unknown }[] = [];
  /** Undelivered inputs per session; prompts are delivered immediately unless queued here. */
  readonly inbox = new Map<string, Array<{ type: "user"; id: string }>>();
  private readonly listeners = new Set<Listener>();
  private counter = 0;
  down = false;

  constructor(version = "2.0.27") {
    this.version = version;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input });
    if (this.down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  }

  emit(type: string, data: Record<string, unknown>): void {
    const event = {
      id: this.nextId("evt"),
      created: Date.now(),
      type,
      data,
    } as unknown as OpenCodeEvent;
    for (const listener of this.listeners) listener(event);
  }

  /** Ends every live event stream, as when the service restarts. */
  dropStreams(): void {
    for (const listener of this.listeners) listener(null);
  }

  // -- worker simulation -------------------------------------------------------

  finish(sessionID: string, text: string): void {
    const session = this.sessions.get(sessionID)!;
    session.messages.push({
      id: this.nextId("msg"),
      type: "assistant",
      content: [{ type: "text", text }],
      time: { created: Date.now() },
      finish: "stop",
    });
    session.outcome = "succeeded";
    this.active.delete(sessionID);
    this.emit("session.status", { sessionID, status: { type: "idle" } });
    this.emit("session.idle", { sessionID });
  }

  /** Appends a raw history message (e.g. an assistant message with tool parts). */
  addMessage(sessionID: string, message: Record<string, unknown>): string {
    const id = (message["id"] as string | undefined) ?? this.nextId("msg");
    this.sessions.get(sessionID)!.messages.push({ time: { created: Date.now() }, ...message, id });
    return id;
  }

  fail(sessionID: string, error: { type: string; message: string; status?: number }): void {
    const session = this.sessions.get(sessionID)!;
    session.messages.push({
      id: this.nextId("msg"),
      type: "assistant",
      content: [],
      time: { created: Date.now() },
      error,
    });
    session.outcome = "failed";
    this.active.delete(sessionID);
    this.emit("session.execution.failed", { sessionID, error });
  }

  askPermission(sessionID: string, action: string, resources: string[]): string {
    const id = this.nextId("per");
    this.pending.permissions.set(id, { id, sessionID, action, resources });
    this.emit("permission.asked", { id, sessionID, action, resources });
    return id;
  }

  askForm(sessionID: string, title: string): string {
    const id = this.nextId("frm");
    const form = { id, sessionID, title, fields: [{ key: "answer", type: "string" }] };
    this.pending.forms.set(id, form);
    this.emit("form.created", { form });
    return id;
  }

  // -- client surface ----------------------------------------------------------

  readonly api: OpenCodeApi = {
    server: {
      info: async () => {
        this.record("server.info", null);
        return {
          version: this.version,
          pid: 1,
          urls: ["http://127.0.0.1:1"],
          paths: { tmp: "/tmp" },
        };
      },
    },
    session: {
      create: async (input) => {
        this.record("session.create", input);
        const i = input as Record<string, unknown> & {
          location: { directory: string };
          model: { providerID: string; id: string };
        };
        const id = this.nextId("ses");
        this.sessions.set(id, {
          id,
          title: typeof i["title"] === "string" ? i["title"] : "",
          directory: i.location.directory,
          metadata: (i["metadata"] as Record<string, unknown>) ?? {},
          model: i.model,
          agent: (i["agent"] as string) ?? null,
          permissions: (i["permissions"] as unknown[]) ?? [],
          messages: [],
        });
        return this.info(id);
      },
      list: async (input) => {
        this.record("session.list", input);
        const i = (input ?? {}) as { search?: string; directory?: string };
        const data = [...this.sessions.values()]
          .filter(
            (s) =>
              (!i.search || s.title.includes(i.search)) &&
              (!i.directory || s.directory === i.directory),
          )
          .map((s) => this.info(s.id));
        return { data, cursor: {} } as never;
      },
      get: async (input) => {
        this.record("session.get", input);
        const { sessionID } = input as { sessionID: string };
        if (!this.sessions.has(sessionID))
          throw Object.assign(new Error("Session not found"), { status: 404 });
        return this.info(sessionID);
      },
      active: async () => {
        this.record("session.active", null);
        return Object.fromEntries([...this.active].map((id) => [id, { type: "running" as const }]));
      },
      prompt: async (input) => {
        this.record("session.prompt", input);
        const { sessionID, text } = input as { sessionID: string; text: string };
        const session = this.sessions.get(sessionID);
        if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
        session.messages.push({
          id: this.nextId("msg"),
          type: "user",
          text,
          time: { created: Date.now() },
        });
        this.active.add(sessionID);
        queueMicrotask(() => this.emit("session.status", { sessionID, status: { type: "busy" } }));
        return {} as never;
      },
      environment: async (input) => {
        this.record("session.environment", input);
        return undefined as never;
      },
      synthetic: async (input) => {
        this.record("session.synthetic", input);
        return {} as never;
      },
      interrupt: async (input) => {
        this.record("session.interrupt", input);
        const { sessionID } = input as { sessionID: string };
        this.active.delete(sessionID);
        return { interrupted: true } as never;
      },
      inbox: {
        list: async (input) => {
          this.record("session.inbox.list", input);
          const { sessionID } = input as { sessionID: string };
          return (this.inbox.get(sessionID) ?? []) as never;
        },
      },
      form: {
        list: async (input) => {
          this.record("session.form.list", input);
          const { sessionID } = input as { sessionID: string };
          return [...this.pending.forms.values()].filter((f) => f.sessionID === sessionID) as never;
        },
        reply: async (input) => {
          this.record("session.form.reply", input);
          const { sessionID, formID } = input as { sessionID: string; formID: string };
          this.pending.forms.delete(formID);
          this.emit("form.replied", { sessionID, formID });
        },
        cancel: async (input) => {
          this.record("session.form.cancel", input);
          const { sessionID, formID } = input as { sessionID: string; formID: string };
          this.pending.forms.delete(formID);
          this.emit("form.cancelled", { sessionID, formID });
        },
      },
    },
    message: {
      list: async (input) => {
        this.record("message.list", input);
        const { sessionID, type, limit, cursor } = input as {
          sessionID: string;
          type?: string;
          limit?: number;
          cursor?: string;
        };
        const session = this.sessions.get(sessionID);
        if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
        // Newest first; the cursor is an offset that continues towards older messages.
        const all = [...session.messages].reverse().filter((m) => !type || m["type"] === type);
        const offset = cursor ? Number(cursor) : 0;
        const end = offset + (limit ?? 50);
        return {
          data: all.slice(offset, end),
          cursor: { next: end < all.length ? String(end) : null },
        } as never;
      },
    },
    permission: {
      list: async (input) => {
        this.record("permission.list", input);
        const { sessionID } = input as { sessionID: string };
        return [...this.pending.permissions.values()].filter(
          (p) => p.sessionID === sessionID,
        ) as never;
      },
      reply: async (input) => {
        this.record("permission.reply", input);
        const { sessionID, requestID } = input as { sessionID: string; requestID: string };
        this.pending.permissions.delete(requestID);
        this.emit("permission.replied", {
          sessionID,
          requestID,
          reply: (input as { decision: string }).decision,
        });
      },
    },
    event: {
      subscribe: (options) => this.stream(options?.signal),
    },
  };

  private info(id: string) {
    const s = this.sessions.get(id)!;
    return {
      id: s.id,
      title: s.title,
      metadata: s.metadata,
      model: s.model,
      projectID: "prj_1",
      cost: 0,
      tokens: {},
      time: { created: 0, updated: 0 },
      location: { directory: s.directory },
      ...(s.outcome ? { outcome: s.outcome } : {}),
    } as never;
  }

  private stream(signal: AbortSignal | undefined): AsyncIterable<OpenCodeEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        if (this.down)
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        const queue: (OpenCodeEvent | null)[] = [
          {
            id: "evt_connected",
            created: Date.now(),
            type: "server.connected",
            data: {},
          } as unknown as OpenCodeEvent,
        ];
        let wake: (() => void) | null = null;
        const listener: Listener = (event) => {
          queue.push(event);
          wake?.();
        };
        this.listeners.add(listener);
        signal?.addEventListener("abort", () => listener(null));
        return {
          next: async (): Promise<IteratorResult<OpenCodeEvent>> => {
            while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            const event = queue.shift()!;
            if (event === null) {
              this.listeners.delete(listener);
              return { done: true, value: undefined };
            }
            return { done: false, value: event };
          },
          return: async (): Promise<IteratorResult<OpenCodeEvent>> => {
            this.listeners.delete(listener);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}
