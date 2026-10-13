import {
  TRANSCRIPT_LIMITS,
  textEntry,
  toolEntry,
  type AdapterStatus,
  type ToolStatus,
  type TranscriptEntry,
} from "@ocd/core";
import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode/client";
import { Service } from "@opencode/client/service";

import {
  HarnessUnavailableError,
  InvalidCursorError,
  type AdapterEvent,
  type AdapterListener,
  type Capabilities,
  type HarnessAdapter,
  type Interaction,
  type InteractionReply,
  type SessionRef,
  type SessionSnapshot,
  type SessionSpec,
  type TranscriptPage,
  type TranscriptRequest,
} from "./types.ts";

// OpenCode V2 worker adapter. Workers are sessions in the user's OpenCode
// service, so they outlive the supervisor; the live event stream has no replay,
// so every reconnect is followed by reconciliation in the supervisor.

/** Versions this adapter's request/response mapping was written and typed against. */
export const OPENCODE_TESTED_VERSIONS = ["2.0.27", "2.0.28"] as const;

/** The subset of the V2 client OCD uses; tests provide a fake with the same shape. */
export interface OpenCodeApi {
  server: Pick<OpenCodeClient["server"], "info">;
  session: Pick<
    OpenCodeClient["session"],
    "create" | "list" | "get" | "active" | "prompt" | "synthetic" | "interrupt" | "environment"
  > & {
    form: Pick<OpenCodeClient["session"]["form"], "list" | "reply" | "cancel">;
    inbox: Pick<OpenCodeClient["session"]["inbox"], "list">;
  };
  message: Pick<OpenCodeClient["message"], "list">;
  permission: Pick<OpenCodeClient["permission"], "list" | "reply">;
  event: Pick<OpenCodeClient["event"], "subscribe">;
}

export interface OpenCodeConnection {
  api: OpenCodeApi;
  url: string;
}

/**
 * Bounds every request except the long-lived event stream, so a hung service
 * cannot hold supervisor locks forever.
 */
function timeoutFetch(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname.endsWith("/event")) return fetch(input, init);
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

/** Connects to the running OpenCode service without starting one. */
export async function discoverOpenCode(
  options: { serviceFile?: string; timeoutMs?: number } = {},
): Promise<OpenCodeConnection | null> {
  const endpoint = await Service.discover(options.serviceFile ? { file: options.serviceFile } : {});
  if (!endpoint) return null;
  const headers = Service.headers(
    endpoint.auth ? { url: endpoint.url, auth: endpoint.auth } : { url: endpoint.url },
  );
  const api = OpenCode.make({
    baseUrl: endpoint.url,
    fetch: timeoutFetch(options.timeoutMs ?? 30_000),
    ...(headers ? { headers } : {}),
  });
  return { api, url: endpoint.url };
}

const CAPABILITIES: Capabilities = {
  start: true,
  inspect: true,
  steer: true,
  interrupt: true,
  resume: true,
  pendingInteractions: true,
  structuredResults: true,
  usage: false,
  // The V2 client (2.0.27) has no checklist events or typed todo tool to follow.
  todos: false,
  transcript: true,
};

const PERMISSION_PREFIX = "perm:";
const FORM_PREFIX = "form:";

export function parseModel(model: string): { providerID: string; id: string; variant?: string } {
  const [ref, variant] = model.split("#", 2);
  const slash = ref!.indexOf("/");
  if (slash <= 0 || slash === ref!.length - 1)
    throw new Error(`OpenCode model must be provider/model, got "${model}"`);
  return {
    providerID: ref!.slice(0, slash),
    id: ref!.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  const e = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  return status === 404 || /not.?found/i.test(e?.message ?? "");
}

function isConnectionRefused(error: unknown): boolean {
  const codes = new Set(["ECONNREFUSED", "ENOENT", "EHOSTUNREACH"]);
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function looksLikeQuota(
  error: { type?: string; message?: string; status?: number } | undefined,
): boolean {
  if (!error) return false;
  return (
    error.status === 429 ||
    /quota|rate.?limit|usage.?limit|insufficient.?credit/i.test(
      `${error.type ?? ""} ${error.message ?? ""}`,
    )
  );
}

const OPENCODE_MESSAGE_PAGE = 50;
const OPENCODE_PAGE_HOPS = 5;

function toolStatus(status: string): ToolStatus {
  return status === "completed"
    ? "completed"
    : status === "error"
      ? "error"
      : status === "running" || status === "streaming"
        ? "running"
        : "unknown";
}

const iso = (ms: number | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/**
 * Visible entries of one OpenCode message: assistant text, tool calls with
 * their results, assistant errors and shell commands. User, synthetic and
 * system messages (prompts and OCD's own instructions) and reasoning parts
 * are skipped.
 */
export function openCodeEntries(message: SessionMessageInfo): TranscriptEntry[] {
  if (message.type === "shell") {
    return [
      toolEntry({
        id: message.id,
        at: iso(message.time.created),
        name: "shell",
        callId: message.shellID,
        status:
          message.status === "running"
            ? "running"
            : message.status === "exited"
              ? "completed"
              : "error",
        input: message.command,
        output: message.output
          ? `${message.output.output}${message.exit !== undefined ? `\n[exit ${String(message.exit)}]` : ""}`
          : null,
      }),
    ];
  }
  if (message.type !== "assistant") return [];
  const at = iso(message.time.created);
  const entries: TranscriptEntry[] = [];
  (Array.isArray(message.content) ? message.content : []).forEach((part, index) => {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      entries.push(textEntry(`${message.id}:${index}`, at, part.text));
    } else if (part?.type === "tool" && typeof part.id === "string") {
      const state = part.state as {
        status: string;
        input?: unknown;
        content?: Array<{ type: string; text?: string; name?: string | null; uri?: string }>;
        error?: { message?: string };
      };
      const content = Array.isArray(state?.content)
        ? state.content
            .map((c) => (c.type === "text" ? (c.text ?? "") : `[file ${c.name ?? c.uri ?? ""}]`))
            .join("\n")
        : null;
      entries.push(
        toolEntry({
          id: `tool:${part.id}`,
          at: iso(part.time?.created) ?? at,
          name: part.name,
          callId: part.id,
          status: toolStatus(state?.status ?? ""),
          input: state?.input ?? null,
          output: state?.error?.message ?? content,
        }),
      );
    }
    // "reasoning": private reasoning, never returned.
  });
  if (message.error?.message)
    entries.push(textEntry(`${message.id}:error`, at, `Error: ${message.error.message}`));
  return entries;
}

export interface OpenCodeAdapterOptions {
  connect: () => Promise<OpenCodeConnection | null>;
  reconnectDelayMs?: { min: number; max: number };
  onError?: (error: unknown, context: string) => void;
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly harness = "opencode" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessionsSurviveSupervisor = true;

  private readonly options: OpenCodeAdapterOptions;
  private connection: OpenCodeConnection | null = null;
  private readonly listeners = new Set<AdapterListener>();
  private readonly tracked = new Set<string>();
  private streamAbort: AbortController | null = null;
  private closed = false;

  constructor(options: OpenCodeAdapterOptions) {
    this.options = options;
  }

  private async api(): Promise<OpenCodeApi> {
    if (this.connection) return this.connection.api;
    let connection: OpenCodeConnection | null;
    try {
      connection = await this.options.connect();
    } catch (error) {
      throw new HarnessUnavailableError(`Cannot reach the OpenCode service: ${String(error)}`, {
        cause: error,
      });
    }
    if (!connection) {
      throw new HarnessUnavailableError(
        "The OpenCode service is not running. Start it with `opencode service start`.",
      );
    }
    this.connection = connection;
    return connection.api;
  }

  async probe(): Promise<AdapterStatus> {
    try {
      const info = await (await this.api()).server.info();
      const tested = (OPENCODE_TESTED_VERSIONS as readonly string[]).includes(info.version);
      return {
        harness: "opencode",
        available: true,
        version: info.version,
        problems: tested
          ? []
          : [
              `OpenCode ${info.version} is untested; the adapter targets ${OPENCODE_TESTED_VERSIONS.join(", ")}`,
            ],
      };
    } catch (error) {
      this.connection = null;
      return {
        harness: "opencode",
        available: false,
        version: null,
        problems: [String((error as Error).message ?? error)],
      };
    }
  }

  subscribe(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    if (!this.streamAbort && !this.closed) void this.runStream();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Keeps one live subscription, reconnecting with backoff. Missed events are recovered by reconciliation. */
  private async runStream(): Promise<void> {
    const { min, max } = this.options.reconnectDelayMs ?? { min: 500, max: 30_000 };
    let delay = min;
    let connectedOnce = false;
    while (!this.closed) {
      const abort = new AbortController();
      this.streamAbort = abort;
      try {
        const api = await this.api();
        for await (const event of api.event.subscribe({ signal: abort.signal })) {
          if (event.type === "server.connected") {
            delay = min;
            connectedOnce = true;
            this.emit({ type: "stream", state: "connected" });
            continue;
          }
          this.handleEvent(event);
        }
      } catch (error) {
        if (this.closed) return;
        this.options.onError?.(error, "event stream");
      }
      if (this.closed) return;
      if (connectedOnce) this.emit({ type: "stream", state: "disconnected" });
      // The service may have restarted with a new port or password.
      this.connection = null;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, max);
    }
  }

  private handleEvent(event: OpenCodeEvent): void {
    const data = (event as { data?: { sessionID?: string } }).data;
    const sessionId = data?.sessionID;
    // Forms carry the session inside the form object.
    const formSession = event.type === "form.created" ? event.data.form.sessionID : undefined;
    const id = sessionId ?? formSession;
    if (!id || !this.tracked.has(id)) return;
    switch (event.type) {
      case "session.status": {
        const status = event.data.status;
        if (status.type === "retry") {
          // Retries (often rate limits) are waits, not hangs.
          this.emit({ type: "activity", sessionId: id });
          return;
        }
        this.emit({
          type: "status",
          sessionId: id,
          status: status.type === "busy" ? "busy" : "idle",
        });
        return;
      }
      case "session.idle":
        this.emit({ type: "status", sessionId: id, status: "idle" });
        return;
      case "session.execution.failed":
        this.emit({
          type: "status",
          sessionId: id,
          status: "error",
          error: event.data.error.message,
          quotaLimited: looksLikeQuota(event.data.error),
        });
        return;
      case "permission.asked":
        this.emit({
          type: "interaction",
          sessionId: id,
          interaction: {
            id: `${PERMISSION_PREFIX}${event.data.id}`,
            kind: "permission",
            summary: `${event.data.action} ${event.data.resources.join(" ")}`.trim(),
            operation: {
              action: event.data.action,
              resources: event.data.resources,
              message: event.data.message ?? null,
            },
          },
        });
        return;
      case "permission.replied":
        this.emit({
          type: "interaction_resolved",
          sessionId: id,
          interactionId: `${PERMISSION_PREFIX}${event.data.requestID}`,
        });
        return;
      case "form.created":
        this.emit({
          type: "interaction",
          sessionId: id,
          interaction: {
            id: `${FORM_PREFIX}${event.data.form.id}`,
            kind: "question",
            summary: event.data.form.title,
            operation: { fields: event.data.form.fields },
          },
        });
        return;
      case "form.replied":
      case "form.cancelled": {
        const formId =
          (event.data as { formID?: string; id?: string }).formID ??
          (event.data as { id?: string }).id;
        if (formId)
          this.emit({
            type: "interaction_resolved",
            sessionId: id,
            interactionId: `${FORM_PREFIX}${formId}`,
          });
        return;
      }
      default:
        this.emit({ type: "activity", sessionId: id });
    }
  }

  async createSession(spec: SessionSpec): Promise<SessionRef> {
    const api = await this.api();
    const info = await this.unlessRefused(() =>
      api.session.create({
        title: spec.title,
        ...(spec.agent ? { agent: spec.agent } : {}),
        model: parseModel(spec.model),
        location: { directory: spec.directory },
        metadata: { ocdTaskId: spec.taskId, ocdRunId: spec.runId, ocdMarker: spec.marker },
        // yolo: allow everything (last matching rule wins). Otherwise edits outside
        // the task's worktree always surface as permission requests.
        permissions:
          spec.permissionPolicy === "yolo"
            ? [{ action: "*", resource: "*", effect: "allow" }]
            : [{ action: "external_directory", resource: "*", effect: "ask" }],
      }),
    );
    this.tracked.add(info.id);
    // Fail closed: a worker must never run with the live OCD environment.
    await this.isolate(api, info.id, spec);
    return { sessionId: info.id };
  }

  /** Points the session's shells at the task's OCD sandbox (see SessionSpec.isolationEnv). */
  private async isolate(api: OpenCodeApi, sessionID: string, spec: SessionSpec): Promise<void> {
    await api.session.environment({ sessionID, variables: spec.isolationEnv } as never);
  }

  async findSession(spec: SessionSpec): Promise<SessionRef | null> {
    if (!spec.directory) return null;
    const api = await this.api();
    const page = await api.session.list({
      search: spec.marker,
      directory: spec.directory,
      limit: 20,
    });
    const match = page.data.find(
      (s: SessionInfo) =>
        s.metadata?.["ocdMarker"] === spec.marker || (s.title ?? "").includes(spec.marker),
    );
    if (!match) return null;
    this.tracked.add(match.id);
    // A crash may have come between creating the session and isolating it.
    await this.isolate(api, match.id, spec);
    return { sessionId: match.id };
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    this.tracked.add(ref.sessionId);
    await (await this.api()).session.prompt({ sessionID: ref.sessionId, text, resume: true });
  }

  /** A refused connection means the request never reached the service. */
  private async unlessRefused<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isConnectionRefused(error)) {
        this.connection = null;
        throw new HarnessUnavailableError(
          `OpenCode service refused the connection: ${String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async inspect(ref: SessionRef): Promise<SessionSnapshot> {
    const api = await this.api();
    const sessionID = ref.sessionId;
    let info: SessionInfo;
    try {
      info = await api.session.get({ sessionID });
    } catch (error) {
      if (isNotFound(error)) {
        return {
          sessionId: sessionID,
          status: "missing",
          prompted: false,
          pending: [],
          lastAssistantText: null,
          error: null,
          quotaLimited: false,
        };
      }
      throw error;
    }
    this.tracked.add(sessionID);
    const [active, permissions, forms, messages, userMessages, inbox] = await Promise.all([
      api.session.active(),
      api.permission.list({ sessionID }),
      api.session.form.list({ sessionID }),
      api.message.list({ sessionID, limit: 50, order: "desc" }),
      api.message.list({ sessionID, limit: 1, type: "user" }),
      api.session.inbox.list({ sessionID }),
    ]);
    const pending: Interaction[] = [
      ...permissions.map((p) => ({
        id: `${PERMISSION_PREFIX}${p.id}`,
        kind: "permission" as const,
        summary: `${p.action} ${p.resources.join(" ")}`.trim(),
        operation: { action: p.action, resources: p.resources, message: p.message ?? null },
      })),
      ...forms.map((f) => ({
        id: `${FORM_PREFIX}${f.id}`,
        kind: "question" as const,
        summary: f.title,
        operation: { fields: f.fields },
      })),
    ];
    // A prompt counts once admitted: delivered as a message or still waiting in the inbox.
    const prompted = userMessages.data.length > 0 || inbox.some((item) => item.type === "user");
    const lastAssistant = messages.data.find((m) => m.type === "assistant");
    const lastAssistantText =
      lastAssistant && lastAssistant.type === "assistant"
        ? lastAssistant.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("\n")
        : null;
    const assistantError =
      lastAssistant && lastAssistant.type === "assistant" ? lastAssistant.error : undefined;
    const busy = Boolean(active[sessionID]);
    let status: SessionSnapshot["status"] = busy ? "busy" : "idle";
    if (pending.length > 0) status = "waiting";
    else if (!busy && (info.outcome === "failed" || assistantError)) status = "error";
    return {
      sessionId: sessionID,
      status,
      prompted,
      pending,
      lastAssistantText,
      error: status === "error" ? (assistantError?.message ?? "OpenCode execution failed") : null,
      quotaLimited: status === "error" && looksLikeQuota(assistantError),
    };
  }

  /**
   * Reads the session's own history with `message.list` (newest page first,
   * then `cursor.next` for older pages, as the 2.0.27 client's own store
   * does). Read-only: no session is created, prompted, resumed or tracked.
   * OpenCode reasoning parts are raw text with no documented summary field,
   * so they are never returned.
   */
  async transcript(ref: SessionRef, request: TranscriptRequest): Promise<TranscriptPage | null> {
    const api = await this.api();
    const sessionID = ref.sessionId;
    let cursor: { page: string | null; anchor: string | null } = { page: null, anchor: null };
    if (request.before !== null) {
      try {
        const parsed = JSON.parse(request.before) as { page?: unknown; anchor?: unknown };
        if (
          (parsed.page !== null && typeof parsed.page !== "string") ||
          (parsed.anchor !== null && typeof parsed.anchor !== "string")
        )
          throw new Error("bad cursor");
        cursor = { page: parsed.page, anchor: parsed.anchor };
      } catch {
        throw new InvalidCursorError();
      }
    }
    const limit = Math.min(request.limit, TRANSCRIPT_LIMITS.maxEntries);
    let page = cursor.page;
    // The anchor (oldest entry already shown) is normally on this page; a busy
    // session may have pushed it onto a later one.
    for (let hop = 0; hop < OPENCODE_PAGE_HOPS; hop += 1) {
      const options = request.signal ? { signal: request.signal } : {};
      let response;
      try {
        response = await api.message.list(
          page === null
            ? { sessionID, limit: OPENCODE_MESSAGE_PAGE, order: "desc" }
            : { sessionID, limit: OPENCODE_MESSAGE_PAGE, cursor: page },
          options,
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const entries = [...response.data].reverse().flatMap(openCodeEntries);
      const next = response.cursor.next ?? null;
      let end = entries.length;
      if (cursor.anchor !== null) {
        const at = entries.findIndex((e) => e.id === cursor.anchor);
        if (at < 0) {
          if (!next) throw new InvalidCursorError();
          page = next;
          continue;
        }
        end = at;
      }
      if (end === 0 && next) {
        // Nothing older on this page: continue on the next one.
        cursor = { page: next, anchor: null };
        page = next;
        continue;
      }
      const start = Math.max(0, end - limit);
      const shown = entries.slice(start, end);
      const before =
        start > 0 && shown[0]
          ? JSON.stringify({ page, anchor: shown[0].id })
          : next
            ? JSON.stringify({ page: next, anchor: null })
            : null;
      return {
        source: "native_history",
        entries: shown,
        before,
        truncated: false,
        reasoningSummaries: "unsupported",
        notes: [],
      };
    }
    if (cursor.anchor !== null) throw new InvalidCursorError();
    // Several pages without visible entries (e.g. only prompts): stop here, bounded.
    return {
      source: "native_history",
      entries: [],
      before: JSON.stringify({ page, anchor: null }),
      truncated: false,
      reasoningSummaries: "unsupported",
      notes: [
        `No visible entries in the ${OPENCODE_PAGE_HOPS * OPENCODE_MESSAGE_PAGE} messages read; older history may have some.`,
      ],
    };
  }

  /** Sessions live in the OpenCode service, so a TUI can join one at any time. */
  interactiveCommand(ref: SessionRef): string[] {
    return ["opencode", "--session", ref.sessionId];
  }

  async interrupt(ref: SessionRef): Promise<void> {
    await (await this.api()).session.interrupt({ sessionID: ref.sessionId });
  }

  async reply(ref: SessionRef, interactionId: string, reply: InteractionReply): Promise<void> {
    const api = await this.api();
    const sessionID = ref.sessionId;
    if (interactionId.startsWith(PERMISSION_PREFIX)) {
      const requestID = interactionId.slice(PERMISSION_PREFIX.length);
      if (reply.type === "answer") throw new Error("Permission requests take approve or deny");
      await api.permission.reply({
        sessionID,
        requestID,
        // Never "always": an approval covers exactly this request.
        decision: reply.type === "approve" ? "once" : "reject",
        ...(reply.type === "deny" && reply.message ? { message: reply.message } : {}),
      });
      return;
    }
    if (interactionId.startsWith(FORM_PREFIX)) {
      const formID = interactionId.slice(FORM_PREFIX.length);
      if (reply.type === "answer") {
        const form = (await api.session.form.list({ sessionID })).find((f) => f.id === formID);
        const field = form?.fields.find((f) => f.type === "string") ?? form?.fields[0];
        if (!field) throw new Error(`Form ${formID} is no longer pending`);
        await api.session.form.reply({ sessionID, formID, answer: { [field.key]: reply.text } });
      } else {
        await api.session.form.cancel({
          sessionID,
          formID,
          ...(reply.type === "deny" && reply.message ? { message: reply.message } : {}),
        });
      }
      return;
    }
    throw new Error(`Unknown OpenCode interaction ${interactionId}`);
  }

  /** Delivers supervisor updates into the manager session without impersonating the human. */
  async wakeManager(sessionId: string, text: string): Promise<void> {
    await (
      await this.api()
    ).session.synthetic({
      sessionID: sessionId,
      text,
      description: "OCD supervisor update",
      delivery: "queue",
      resume: true,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.streamAbort?.abort();
    this.listeners.clear();
  }
}
