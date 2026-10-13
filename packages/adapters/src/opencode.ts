import type { AdapterStatus } from "@ocd/core";
import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
} from "@opencode/client";
import { Service } from "@opencode/client/service";

import {
  HarnessUnavailableError,
  type AdapterEvent,
  type AdapterListener,
  type Capabilities,
  type HarnessAdapter,
  type Interaction,
  type InteractionReply,
  type SessionRef,
  type SessionSnapshot,
  type SessionSpec,
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
    "create" | "list" | "get" | "active" | "prompt" | "synthetic" | "interrupt"
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
    return { sessionId: info.id };
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
