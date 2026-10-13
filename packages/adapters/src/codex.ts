import { execFile } from "node:child_process";

import type { AdapterStatus } from "@ocd/core";

import { JsonLineProcess } from "./jsonl-process.ts";
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

// Codex worker adapter over `codex app-server` (JSON-RPC 2.0 without the
// "jsonrpc" field, newline-delimited, on stdio). Each session runs its own
// app-server process in the task worktree; the thread id is the session id.
// Workers die with the supervisor, and `thread/resume` continues them later.

export const CODEX_TESTED_VERSIONS = ["0.162.1"] as const;

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

const REQUEST_TIMEOUT_MS = 60_000;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LIMIT_ERRORS = new Set(["usageLimitExceeded", "rateLimitExceeded"]);

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

/** `model#effort` -> model and reasoning effort. */
export function parseCodexModel(model: string): { model: string; effort: string | null } {
  const [name, effort] = model.split("#", 2);
  return { model: name!, effort: effort ?? null };
}

interface CodexSession {
  threadId: string;
  spec: SessionSpec;
  proc: JsonLineProcess;
  nextId: number;
  calls: Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >;
  status: SessionSnapshot["status"];
  activeTurnId: string | null;
  prompted: boolean;
  pending: Map<string, Interaction & { rpcId: string | number }>;
  fileChanges: Map<string, string[]>;
  lastAssistantText: string | null;
  error: string | null;
  quotaLimited: boolean;
  /** The process was stopped while idle; the thread resumes on the next prompt. */
  parked: boolean;
  idleTimer: NodeJS.Timeout | null;
  /** Turns that already completed; their turn/start reply may arrive late. */
  finishedTurns: Set<string>;
}

export interface CodexAdapterOptions {
  /** Executable and leading args; defaults to `codex app-server`. */
  command?: [string, ...string[]];
  onError?: (error: unknown, context: string) => void;
  /** Stop a worker process after this long idle; its thread resumes on demand. */
  idleStopMs?: number;
}

export class CodexAdapter implements HarnessAdapter {
  readonly harness = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessionsSurviveSupervisor = false;

  private readonly command: [string, ...string[]];
  private readonly options: CodexAdapterOptions;
  private readonly sessions = new Map<string, CodexSession>();
  private readonly byMarker = new Map<string, string>();
  private readonly listeners = new Set<AdapterListener>();

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
    this.command = options.command ?? ["codex", "app-server"];
  }

  probe(): Promise<AdapterStatus> {
    return new Promise((resolve) => {
      execFile(this.command[0], ["--version"], { timeout: 10_000 }, (error, stdout) => {
        if (error) {
          resolve({
            harness: "codex",
            available: false,
            version: null,
            problems: [`${this.command[0]} not found or not runnable`],
          });
          return;
        }
        const version = /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? String(stdout).trim();
        const tested = (CODEX_TESTED_VERSIONS as readonly string[]).includes(version);
        resolve({
          harness: "codex",
          available: true,
          version,
          problems: tested
            ? []
            : [
                `Codex ${version} is untested; the adapter targets ${CODEX_TESTED_VERSIONS.join(", ")}`,
              ],
        });
      });
    });
  }

  subscribe(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // -- process and RPC ----------------------------------------------------------

  private async spawn(spec: SessionSpec): Promise<CodexSession> {
    // Partially initialised until thread/start or thread/resume returns an id.
    const session = { parked: false, idleTimer: null } as unknown as CodexSession;
    await this.startProcess(session, spec);
    return session;
  }

  /** Starts an app-server for a session object and completes the handshake. */
  private async startProcess(session: CodexSession, spec: SessionSpec): Promise<void> {
    session.calls = new Map();
    session.nextId = 0;
    const [cmd, ...args] = this.command;
    const proc = new JsonLineProcess(cmd, args, {
      cwd: spec.directory,
      env: spec.env,
      onMessage: (m) => this.onMessage(session, m as RpcMessage),
      onInvalidLine: (line) =>
        this.options.onError?.(new Error(line.slice(0, 200)), "codex stdout"),
    });
    session.proc = proc;
    session.parked = false;
    // Ignore exits of a process that has since been replaced.
    void proc.exited.then((exit) => {
      if (session.proc === proc) this.onExit(session, exit);
    });
    try {
      await this.call(session, "initialize", {
        clientInfo: { name: "ocd", title: "OCD supervisor", version: "0.1.0" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: ["item/reasoning/textDelta"],
        },
      });
    } catch (error) {
      await proc.stop(500);
      throw new HarnessUnavailableError(
        `Could not start codex app-server: ${(error as Error).message} ${proc.stderr()}`.trim(),
        {
          cause: error,
        },
      );
    }
    proc.send({ method: "initialized" });
    const account = (await this.call(session, "account/read", { refreshToken: false })) as {
      account: unknown;
    };
    if (!account.account) {
      await proc.stop(500);
      throw new HarnessUnavailableError("Codex is not logged in. Run `codex login`.");
    }
  }

  private scheduleIdleStop(session: CodexSession): void {
    this.clearIdleStop(session);
    session.idleTimer = setTimeout(
      () => void this.park(session),
      this.options.idleStopMs ?? 10 * 60_000,
    );
    session.idleTimer.unref();
  }

  private clearIdleStop(session: CodexSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  /** Stops an idle app-server; the thread stays resumable. */
  private async park(session: CodexSession): Promise<void> {
    this.clearIdleStop(session);
    if (
      !session.proc.running ||
      session.activeTurnId ||
      session.status === "busy" ||
      session.status === "waiting"
    )
      return;
    session.parked = true;
    await session.proc.stop(2000);
  }

  /** Restarts a parked session's app-server and resumes its thread. */
  private async resumeThread(session: CodexSession): Promise<void> {
    await this.startProcess(session, session.spec);
    await this.call(session, "thread/resume", {
      threadId: session.threadId,
      ...this.threadParams(session.spec),
    });
  }

  private call(
    session: CodexSession,
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.calls.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      session.calls.set(id, { resolve, reject, timer });
      try {
        session.proc.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        session.calls.delete(id);
        reject(error as Error);
      }
    });
  }

  private onMessage(session: CodexSession, message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const call = session.calls.get(message.id);
      if (!call) return;
      session.calls.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.onServerRequest(session, message.id, message.method, message.params ?? {});
      return;
    }
    if (message.method) this.onNotification(session, message.method, message.params ?? {});
  }

  private onServerRequest(
    session: CodexSession,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (!APPROVAL_METHODS.has(method)) {
      // Never leave the worker waiting on something OCD cannot answer.
      if (method === "mcpServer/elicitation/request")
        session.proc.send({ id, result: { action: "decline", content: null } });
      else
        session.proc.send({
          id,
          error: { code: -32601, message: `OCD does not handle ${method}` },
        });
      return;
    }
    const interaction = this.toInteraction(session, id, method, params);
    session.pending.set(interaction.id, { ...interaction, rpcId: id });
    session.status = "waiting";
    this.emit({ type: "interaction", sessionId: session.threadId, interaction });
  }

  private toInteraction(
    session: CodexSession,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
  ): Interaction {
    const reason = typeof params["reason"] === "string" ? ` (${params["reason"]})` : "";
    if (method === "item/commandExecution/requestApproval") {
      const raw = params["command"];
      const command =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.join(" ")
            : JSON.stringify(raw ?? "");
      return {
        id: `req:${id}`,
        kind: "permission",
        summary: `shell: ${command}${reason}`,
        operation: {
          kind: "command",
          command,
          cwd: params["cwd"] ?? null,
          reason: params["reason"] ?? null,
        },
      };
    }
    const paths = session.fileChanges.get(String(params["itemId"])) ?? [];
    return {
      id: `req:${id}`,
      kind: "permission",
      summary: `edit: ${paths.join(", ") || "files"}${reason}`,
      operation: {
        kind: "fileChange",
        paths,
        grantRoot: params["grantRoot"] ?? null,
        reason: params["reason"] ?? null,
      },
    };
  }

  private onNotification(
    session: CodexSession,
    method: string,
    params: Record<string, unknown>,
  ): void {
    const sessionId = session.threadId;
    if (!sessionId) return;
    switch (method) {
      case "turn/started": {
        const turn = params["turn"] as { id: string };
        session.activeTurnId = turn.id;
        session.status = "busy";
        this.emit({ type: "status", sessionId, status: "busy" });
        return;
      }
      case "item/started": {
        const item = params["item"] as { type?: string; id?: string; changes?: { path: string }[] };
        if (item.type === "fileChange" && item.id)
          session.fileChanges.set(
            item.id,
            (item.changes ?? []).map((c) => c.path),
          );
        this.emit({ type: "activity", sessionId });
        return;
      }
      case "item/completed": {
        const item = params["item"] as { type?: string; text?: string };
        if (item.type === "agentMessage" && item.text) session.lastAssistantText = item.text;
        this.emit({ type: "activity", sessionId });
        return;
      }
      case "serverRequest/resolved": {
        const requestId = `req:${String(params["requestId"])}`;
        if (session.pending.delete(requestId)) {
          if (session.status === "waiting" && session.pending.size === 0) session.status = "busy";
          this.emit({ type: "interaction_resolved", sessionId, interactionId: requestId });
        }
        return;
      }
      case "error": {
        const error = params["error"] as { message?: string; codexErrorInfo?: unknown } | undefined;
        if (!params["willRetry"] && error) {
          session.error = error.message ?? "Codex error";
          session.quotaLimited =
            typeof error.codexErrorInfo === "string" && LIMIT_ERRORS.has(error.codexErrorInfo);
        }
        return;
      }
      case "turn/completed": {
        const turn = params["turn"] as {
          id: string;
          status: "completed" | "interrupted" | "failed";
          error: { message?: string; codexErrorInfo?: unknown } | null;
          items?: { type?: string; text?: string }[];
        };
        const final = turn.items?.find((i) => i.type === "agentMessage")?.text;
        if (final) session.lastAssistantText = final;
        session.finishedTurns.add(turn.id);
        session.activeTurnId = null;
        session.pending.clear();
        if (turn.status === "failed") {
          session.error = turn.error?.message ?? session.error ?? "Codex turn failed";
          const info = turn.error?.codexErrorInfo;
          session.quotaLimited ||= typeof info === "string" && LIMIT_ERRORS.has(info);
          session.status = "error";
          this.emit({
            type: "status",
            sessionId,
            status: "error",
            error: session.error,
            quotaLimited: session.quotaLimited,
          });
        } else {
          session.status = "idle";
          this.emit({ type: "status", sessionId, status: "idle" });
        }
        this.scheduleIdleStop(session);
        return;
      }
      default:
        if (method.startsWith("item/") || method.startsWith("turn/"))
          this.emit({ type: "activity", sessionId });
    }
  }

  private onExit(
    session: CodexSession,
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    for (const call of session.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("codex app-server exited"));
    }
    session.calls.clear();
    if (!session.threadId || this.sessions.get(session.threadId) !== session || session.parked)
      return;
    // An unexpected exit while working is an error; the session can be revived from disk.
    if (session.status === "busy" || session.status === "waiting") {
      session.error = `codex app-server exited (${exit.signal ?? exit.code}): ${session.proc.stderr().slice(-500)}`;
      session.status = "error";
      this.emit({
        type: "status",
        sessionId: session.threadId,
        status: "error",
        error: session.error,
      });
    }
  }

  private threadParams(spec: SessionSpec) {
    if (spec.permissionPolicy === "yolo") {
      return {
        cwd: spec.directory,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      };
    }
    // Free inside the worktree; anything riskier becomes an approval request
    // that OCD answers according to the profile's permission policy.
    return {
      cwd: spec.directory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
  }

  private register(session: CodexSession, threadId: string, spec: SessionSpec): void {
    Object.assign(session, {
      threadId,
      spec,
      status: "idle",
      activeTurnId: null,
      prompted: session.prompted ?? false,
      pending: new Map(),
      fileChanges: new Map(),
      lastAssistantText: session.lastAssistantText ?? null,
      error: null,
      quotaLimited: false,
      parked: false,
      idleTimer: null,
      finishedTurns: session.finishedTurns ?? new Set(),
    } satisfies Partial<CodexSession>);
    this.sessions.set(threadId, session);
    this.byMarker.set(spec.marker, threadId);
  }

  // -- HarnessAdapter -------------------------------------------------------------

  async createSession(spec: SessionSpec): Promise<SessionRef> {
    const session = await this.spawn(spec);
    const { model } = parseCodexModel(spec.model);
    const result = (await this.call(session, "thread/start", {
      ...this.threadParams(spec),
      model,
      serviceName: "ocd",
    })) as { thread: { id: string } };
    this.register(session, result.thread.id, spec);
    return { sessionId: result.thread.id };
  }

  async findSession(spec: SessionSpec): Promise<SessionRef | null> {
    const id = this.byMarker.get(spec.marker);
    return id ? { sessionId: id } : null;
  }

  async revive(ref: SessionRef, spec: SessionSpec): Promise<void> {
    const existing = this.sessions.get(ref.sessionId);
    if (existing?.proc.running) return;
    if (existing) {
      await this.resumeThread(existing);
      return;
    }
    const session = await this.spawn(spec);
    await this.call(session, "thread/resume", {
      threadId: ref.sessionId,
      ...this.threadParams(spec),
    });
    session.prompted = true;
    this.register(session, ref.sessionId, spec);
  }

  /** Ends a finished task's worker. A later reattach can still resume the thread. */
  async release(ref: SessionRef): Promise<void> {
    const session = this.sessions.get(ref.sessionId);
    if (!session) return;
    this.clearIdleStop(session);
    session.parked = true;
    this.sessions.delete(ref.sessionId);
    this.byMarker.delete(session.spec.marker);
    await session.proc.stop(2000);
  }

  /** Number of running worker processes (for status and tests). */
  activeWorkers(): number {
    return [...this.sessions.values()].filter((s) => s.proc.running).length;
  }

  private live(ref: SessionRef): CodexSession {
    const session = this.sessions.get(ref.sessionId);
    if (!session || !session.proc.running)
      throw new Error(`Codex session ${ref.sessionId} has no running worker`);
    return session;
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    const parked = this.sessions.get(ref.sessionId);
    if (parked && !parked.proc.running && (parked.parked || parked.status !== "busy"))
      await this.resumeThread(parked);
    const session = this.live(ref);
    this.clearIdleStop(session);
    const input = [{ type: "text", text }];
    if (session.activeTurnId) {
      await this.call(session, "turn/steer", {
        threadId: session.threadId,
        expectedTurnId: session.activeTurnId,
        input,
      });
    } else {
      const { effort } = parseCodexModel(session.spec.model);
      // Busy before the request: the turn's notifications can arrive before its
      // reply, and a turn that already completed must not be marked busy again.
      session.status = "busy";
      session.error = null;
      session.quotaLimited = false;
      const result = (await this.call(session, "turn/start", {
        threadId: session.threadId,
        input,
        ...(effort ? { effort } : {}),
      })) as { turn: { id: string } };
      if (!session.finishedTurns.has(result.turn.id)) session.activeTurnId = result.turn.id;
    }
    session.prompted = true;
  }

  async inspect(ref: SessionRef): Promise<SessionSnapshot> {
    const session = this.sessions.get(ref.sessionId);
    if (!session || (!session.proc.running && !session.parked && session.status !== "error")) {
      return {
        sessionId: ref.sessionId,
        status: "missing",
        prompted: false,
        pending: [],
        lastAssistantText: null,
        error: null,
        quotaLimited: false,
      };
    }
    return {
      sessionId: ref.sessionId,
      status: session.pending.size > 0 ? "waiting" : session.status,
      prompted: session.prompted,
      pending: [...session.pending.values()].map(
        ({ rpcId: _rpcId, ...interaction }) => interaction,
      ),
      lastAssistantText: session.lastAssistantText,
      error: session.error,
      quotaLimited: session.quotaLimited,
    };
  }

  async interrupt(ref: SessionRef): Promise<void> {
    const session = this.sessions.get(ref.sessionId);
    if (!session?.proc.running || !session.activeTurnId) return;
    await this.call(session, "turn/interrupt", {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });
  }

  async reply(ref: SessionRef, interactionId: string, reply: InteractionReply): Promise<void> {
    const session = this.live(ref);
    const pending = session.pending.get(interactionId);
    if (!pending) throw new Error(`No pending Codex request ${interactionId}`);
    if (reply.type === "answer") throw new Error("Codex approval requests take approve or deny");
    // Never "acceptForSession": an approval covers exactly this request.
    session.proc.send({
      id: pending.rpcId,
      result: { decision: reply.type === "approve" ? "accept" : "decline" },
    });
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      this.clearIdleStop(s);
      s.parked = true;
    }
    await Promise.all([...this.sessions.values()].map((s) => s.proc.stop(2000)));
    this.sessions.clear();
    this.byMarker.clear();
    this.listeners.clear();
  }
}
