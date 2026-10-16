import { execFile } from "node:child_process";
import { homedir } from "node:os";

import {
  boundTodos,
  textEntry,
  toolEntry,
  type AdapterStatus,
  type HarnessUsage,
  type ToolStatus,
  type TranscriptEntry,
} from "@ocd/core";

import { processMentioning } from "./processes.ts";
import { JsonLineProcess } from "./jsonl-process.ts";
import { TranscriptStore, type TranscriptBufferLimits } from "./transcript-buffer.ts";
import { codexUsage, type CodexRateLimitsResponse } from "./usage-limits.ts";
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
  type TranscriptPage,
  type TranscriptRequest,
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
  todos: true,
  transcript: true,
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
  /** The in-flight stop of an idle app-server; a prompt waits for it, then resumes. */
  stopping: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  /** An agent message completed during the current turn (the final answer so far). */
  turnTextSet: boolean;
  /** Turns that already completed; their turn/start reply may arrive late. */
  finishedTurns: Set<string>;
  /** A pending re-read of the account's limits after `account/rateLimits/updated`. */
  limitsTimer?: NodeJS.Timeout | null;
}

/** The part of a session that RPC calls need; also used for short-lived reads. */
type RpcChannel = Pick<CodexSession, "proc" | "nextId" | "calls">;

export interface CodexAdapterOptions {
  /** Executable and leading args; defaults to `codex app-server`. */
  command?: [string, ...string[]];
  onError?: (error: unknown, context: string) => void;
  /** Stop a worker process after this long idle; its thread resumes on demand. */
  idleStopMs?: number;
  transcriptLimits?: Partial<TranscriptBufferLimits>;
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
  private readonly transcripts: TranscriptStore;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = options;
    this.command = options.command ?? ["codex", "app-server"];
    this.transcripts = new TranscriptStore(options.transcriptLimits);
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
    const session = { parked: false, stopping: null, idleTimer: null } as unknown as CodexSession;
    await this.startProcess(session, spec);
    return session;
  }

  /** Starts an app-server for a session object and completes the handshake. */
  private async startProcess(session: CodexSession, spec: SessionSpec): Promise<void> {
    session.calls = new Map();
    session.nextId = 0;
    // A new process knows nothing of the old one's turn or requests.
    if (session.pending) this.resetProcessState(session);
    const [cmd, ...args] = this.command;
    const proc = new JsonLineProcess(cmd, args, {
      cwd: spec.directory,
      env: spec.env,
      onMessage: (m) => this.onMessage(session, m as RpcMessage),
      onInvalidLine: (line) =>
        this.options.onError?.(new Error(line.slice(0, 200)), "codex stdout"),
      onError: (error) => this.options.onError?.(error, "codex message"),
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
    let account: { account: unknown } | null;
    try {
      account = (await this.call(session, "account/read", { refreshToken: false })) as {
        account: unknown;
      } | null;
    } catch (error) {
      session.parked = true;
      await proc.stop(500);
      throw error;
    }
    if (!account?.account) {
      await proc.stop(500);
      throw new HarnessUnavailableError("Codex is not logged in. Run `codex login`.");
    }
    // The account's usage limits, read once per process (no model call).
    void this.emitLimits(session);
  }

  /** Reads the account's limits over a channel and emits them; failures are only logged. */
  private async emitLimits(channel: RpcChannel): Promise<HarnessUsage | null> {
    try {
      const response = (await this.call(
        channel,
        "account/rateLimits/read",
        undefined,
        15_000,
      )) as CodexRateLimitsResponse | null;
      if (!response) return null;
      const usage = codexUsage(response, new Date().toISOString());
      this.emit({ type: "limits", usage });
      return usage;
    } catch (error) {
      this.options.onError?.(error, "codex limits");
      return null;
    }
  }

  /**
   * Reads the account's limits from a short-lived app-server, so they stay
   * current while no Codex worker runs. No thread is started and no model is
   * called.
   */
  async readLimits(): Promise<HarnessUsage | null> {
    const [cmd, ...args] = this.command;
    const channel: RpcChannel = { nextId: 0, calls: new Map() } as unknown as RpcChannel;
    const proc = new JsonLineProcess(cmd, args, {
      cwd: homedir(),
      env: process.env as Record<string, string>,
      onMessage: (m) => this.onResponse(channel, m as RpcMessage),
      onError: (error) => this.options.onError?.(error, "codex limits"),
    });
    channel.proc = proc;
    void proc.exited.then(() => {
      for (const call of channel.calls.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("codex app-server exited"));
      }
      channel.calls.clear();
    });
    try {
      await this.call(
        channel,
        "initialize",
        {
          clientInfo: { name: "ocd", title: "OCD supervisor", version: "0.1.0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        15_000,
      );
      proc.send({ method: "initialized" });
      return await this.emitLimits(channel);
    } catch (error) {
      this.options.onError?.(error, "codex limits");
      return null;
    } finally {
      await proc.stop(1000);
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
    const stopping = session.proc.stop(2000).finally(() => {
      if (session.stopping === stopping) session.stopping = null;
    });
    session.stopping = stopping;
    await stopping;
  }

  /** Forgets the turn, requests and file changes of a process that is gone or replaced. */
  private resetProcessState(session: CodexSession): void {
    session.activeTurnId = null;
    session.pending.clear();
    session.fileChanges.clear();
  }

  /** Restarts a parked session's app-server and resumes its thread. */
  private async resumeThread(session: CodexSession): Promise<void> {
    await this.startProcess(session, session.spec);
    await this.resumeOn(session, session.spec, session.threadId);
  }

  /** thread/resume on the session's current process; the process is stopped if it fails. */
  private async resumeOn(
    session: CodexSession,
    spec: SessionSpec,
    threadId: string,
  ): Promise<void> {
    try {
      await this.call(session, "thread/resume", { threadId, ...this.threadParams(spec) });
    } catch (error) {
      session.parked = true;
      await session.proc.stop(500);
      throw error;
    }
  }

  private call(
    session: RpcChannel,
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

  /** Settles the call a response answers; false when the message is not a response. */
  private onResponse(channel: RpcChannel, message: RpcMessage): boolean {
    if (message.id === undefined || message.method !== undefined) return false;
    const call = channel.calls.get(message.id);
    if (!call) return true;
    channel.calls.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message));
    else call.resolve(message.result);
    return true;
  }

  private onMessage(session: CodexSession, message: RpcMessage): void {
    if (this.onResponse(session, message)) return;
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
    if (method === "account/rateLimits/updated") {
      // A sparse update: re-read the whole snapshot (debounced) rather than merge.
      if (session.limitsTimer) clearTimeout(session.limitsTimer);
      session.limitsTimer = setTimeout(() => {
        session.limitsTimer = null;
        if (session.proc.running) void this.emitLimits(session);
      }, 1000);
      session.limitsTimer.unref();
      return;
    }
    const sessionId = session.threadId;
    if (!sessionId) return;
    if (method === "item/started") {
      // Any thread's edit may come back as an approval request that names it.
      const item = (params["item"] ?? {}) as {
        type?: string;
        id?: string;
        changes?: ({ path?: unknown } | null)[];
      };
      if (item.type === "fileChange" && item.id)
        session.fileChanges.set(
          item.id,
          (Array.isArray(item.changes) ? item.changes : []).flatMap((c) =>
            typeof c?.path === "string" ? [c.path] : [],
          ),
        );
    }
    // A spawned subagent's thread streams over the same connection. Its work is
    // the worker's activity, but its turns and messages are not the worker's.
    const thread = params["threadId"];
    if (typeof thread === "string" && thread !== sessionId && method !== "serverRequest/resolved") {
      this.emit({ type: "activity", sessionId });
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = params["turn"] as { id?: unknown } | undefined;
        if (typeof turn?.id === "string") session.activeTurnId = turn.id;
        session.turnTextSet = false;
        session.status = "busy";
        this.emit({ type: "status", sessionId, status: "busy" });
        return;
      }
      case "item/started": {
        this.record(session, params["item"], params["startedAtMs"]);
        this.emit({ type: "activity", sessionId });
        return;
      }
      case "item/completed": {
        const item = (params["item"] ?? {}) as { type?: string; text?: unknown };
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
          session.lastAssistantText = item.text;
          session.turnTextSet = true;
        }
        this.record(session, params["item"], params["completedAtMs"]);
        this.emit({ type: "activity", sessionId });
        return;
      }
      case "turn/plan/updated": {
        // The agent's own plan steps; the free-text explanation is left out.
        const plan = params["plan"];
        if (Array.isArray(plan)) {
          const steps = plan as { step?: unknown; status?: unknown }[];
          this.emit({
            type: "todos",
            sessionId,
            todos: boundTodos(steps.map((s) => ({ text: s.step, status: s.status }))),
          });
        }
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
        const turn = (params["turn"] ?? {}) as {
          id?: unknown;
          status?: "completed" | "interrupted" | "failed";
          error?: { message?: string; codexErrorInfo?: unknown } | null;
          items?: ({ type?: string; text?: unknown } | null)[];
        };
        // item/completed already set the final message; fall back to the turn's
        // own items only when none was seen, and then take the last one.
        if (!session.turnTextSet && Array.isArray(turn.items)) {
          const messages = turn.items.filter(
            (i) => i?.type === "agentMessage" && typeof i.text === "string" && i.text,
          );
          const final = messages[messages.length - 1]?.text;
          if (typeof final === "string") session.lastAssistantText = final;
        }
        session.turnTextSet = false;
        if (typeof turn.id === "string") session.finishedTurns.add(turn.id);
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
    // Whatever the dead process was doing or waiting on is gone with it.
    if (session.pending) this.resetProcessState(session);
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
      stopping: null,
      idleTimer: null,
      turnTextSet: false,
      finishedTurns: session.finishedTurns ?? new Set(),
    } satisfies Partial<CodexSession>);
    this.sessions.set(threadId, session);
    this.byMarker.set(spec.marker, threadId);
  }

  // -- HarnessAdapter -------------------------------------------------------------

  async createSession(spec: SessionSpec): Promise<SessionRef> {
    const session = await this.spawn(spec);
    const { model } = parseCodexModel(spec.model);
    let threadId: string;
    try {
      const result = (await this.call(session, "thread/start", {
        ...this.threadParams(spec),
        model,
        serviceName: "ocd",
      })) as { thread?: { id?: unknown } } | null;
      if (typeof result?.thread?.id !== "string")
        throw new Error("thread/start returned no thread");
      threadId = result.thread.id;
    } catch (error) {
      // The session is not registered yet; nothing else would ever stop this process.
      session.parked = true;
      await session.proc.stop(500);
      throw error;
    }
    this.register(session, threadId, spec);
    return { sessionId: threadId };
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
    await this.resumeOn(session, spec, ref.sessionId);
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
    this.transcripts.release(ref.sessionId);
    await session.proc.stop(2000);
  }

  /**
   * What this adapter saw the worker do, from memory only. Codex also offers
   * `thread/items/list`, but only through a running app-server; peeking must
   * never start one, so parked, released and unknown threads are read as is.
   */
  async transcript(ref: SessionRef, request: TranscriptRequest): Promise<TranscriptPage | null> {
    return this.transcripts.read(ref.sessionId, request, "supported");
  }

  /**
   * Keeps complete thread items (item/started, then item/completed with the
   * same id): agent messages, plans, tool calls with their output, and the
   * `summary` of reasoning items. Never a reasoning item's `content` (raw
   * reasoning), user messages or hook prompts, and no streaming deltas.
   */
  private record(session: CodexSession, raw: unknown, atMs: unknown): void {
    if (!session.threadId || this.sessions.get(session.threadId) !== session) return;
    if (!raw || typeof raw !== "object") return;
    try {
      const entry = codexEntry(
        raw as CodexItem,
        typeof atMs === "number" ? new Date(atMs).toISOString() : new Date().toISOString(),
      );
      if (!entry) return;
      const buffer = this.transcripts.live(session.threadId);
      // A completed item keeps its start time and position.
      const started = buffer.get(entry.id);
      buffer.upsert(started ? { ...entry, at: started.at } : entry);
    } catch (error) {
      this.options.onError?.(error, "codex transcript");
    }
  }

  interactiveCommand(ref: SessionRef): string[] {
    return [this.command[0], "resume", ref.sessionId];
  }

  async sessionInUse(ref: SessionRef): Promise<{ pid: number; command: string } | null> {
    if (this.sessions.get(ref.sessionId)?.proc.running) return null;
    return processMentioning(ref.sessionId);
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
    let parked = this.sessions.get(ref.sessionId);
    if (parked?.stopping) {
      await parked.stopping;
      parked = this.sessions.get(ref.sessionId); // may have been released meanwhile
    }
    if (parked && !parked.proc.running && (parked.parked || parked.status !== "busy"))
      await this.resumeThread(parked);
    const session = this.live(ref);
    this.clearIdleStop(session);
    const input = [{ type: "text", text }];
    let steered = false;
    if (session.activeTurnId) {
      const turnId = session.activeTurnId;
      try {
        await this.call(session, "turn/steer", {
          threadId: session.threadId,
          expectedTurnId: turnId,
          input,
        });
        steered = true;
      } catch (error) {
        // The turn ended (on its own, or by an interrupt) between our view of it
        // and the steer arriving: Codex refuses, and the text starts a new turn.
        const ended =
          session.activeTurnId !== turnId ||
          /no active turn|expected turn/i.test(error instanceof Error ? error.message : "");
        if (!ended) throw error;
        if (session.activeTurnId === turnId) session.activeTurnId = null;
      }
    }
    if (!steered) {
      const { effort } = parseCodexModel(session.spec.model);
      // Busy before the request: the turn's notifications can arrive before its
      // reply, and a turn that already completed must not be marked busy again.
      const before = {
        status: session.status,
        error: session.error,
        quotaLimited: session.quotaLimited,
      };
      session.status = "busy";
      session.error = null;
      session.quotaLimited = false;
      let result: { turn?: { id?: unknown } } | null;
      try {
        result = (await this.call(session, "turn/start", {
          threadId: session.threadId,
          input,
          ...(effort ? { effort } : {}),
        })) as { turn?: { id?: unknown } } | null;
      } catch (error) {
        // No turn started: do not leave the session busy forever.
        if (session.status === "busy" && !session.activeTurnId) Object.assign(session, before);
        throw error;
      }
      const turnId = result?.turn?.id;
      if (typeof turnId === "string" && !session.finishedTurns.has(turnId))
        session.activeTurnId = turnId;
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
    const turnId = session.activeTurnId;
    await this.call(session, "turn/interrupt", { threadId: session.threadId, turnId });
    // Codex acknowledges before the turn reports completion; wait (bounded) for
    // it, so a prompt sent right after starts a new turn instead of steering a
    // turn that is already over.
    const deadline = Date.now() + 10_000;
    while (session.activeTurnId === turnId && session.proc.running && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
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
    this.transcripts.clear();
  }
}

/** The parts of a v2 `ThreadItem` (0.162.1 generated schema) OCD reads. */
type CodexItem = {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  summary?: unknown;
  command?: unknown;
  status?: unknown;
  aggregatedOutput?: unknown;
  exitCode?: unknown;
  changes?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  contentItems?: unknown;
  query?: unknown;
  path?: unknown;
};

function codexStatus(status: unknown): ToolStatus {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "declined":
      return "declined";
    default:
      return "unknown";
  }
}

/** Text parts of MCP / dynamic tool content; other parts (images, audio) by type only. */
function texts(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  const parts = items.flatMap((c: { type?: unknown; text?: unknown } | null) =>
    typeof c?.text === "string" ? [c.text] : typeof c?.type === "string" ? [`[${c.type}]`] : [],
  );
  return parts.length ? parts.join("\n") : null;
}

/** One transcript entry for a thread item, or null for items that are not shown. */
export function codexEntry(item: CodexItem, at: string): TranscriptEntry | null {
  if (typeof item.id !== "string" || !item.id) return null;
  const id = item.id;
  const tool = (name: string, input: unknown, output: string | null, status: unknown) =>
    toolEntry({ id, at, name, callId: id, status: codexStatus(status), input, output });
  switch (item.type) {
    case "agentMessage":
      return typeof item.text === "string" && item.text.trim()
        ? textEntry(id, at, item.text)
        : null;
    case "plan":
      return typeof item.text === "string" && item.text.trim()
        ? textEntry(id, at, `Plan:\n${item.text}`)
        : null;
    case "reasoning": {
      // Only the documented summary; `content` is raw reasoning and is never read.
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((s): s is string => typeof s === "string" && s.trim() !== "")
        : [];
      return summary.length ? textEntry(id, at, summary.join("\n\n"), "reasoning_summary") : null;
    }
    case "commandExecution": {
      const exit = typeof item.exitCode === "number" ? `\n[exit ${item.exitCode}]` : "";
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null;
      return tool(
        "shell",
        item.command,
        output !== null || exit ? `${output ?? ""}${exit}`.trim() : null,
        item.status,
      );
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? item.changes.map((c: { path?: unknown; kind?: { type?: unknown } }) => ({
            path: c?.path,
            kind: c?.kind?.type,
          }))
        : [];
      return tool("edit", changes, null, item.status);
    }
    case "mcpToolCall": {
      const result = item.result as { content?: unknown } | null | undefined;
      const error = item.error as { message?: unknown } | null | undefined;
      const output = typeof error?.message === "string" ? error.message : texts(result?.content);
      return tool(
        `mcp:${String(item.server)}/${String(item.tool)}`,
        item.arguments,
        output,
        item.status,
      );
    }
    case "dynamicToolCall":
      return tool(String(item.tool), item.arguments, texts(item.contentItems), item.status);
    case "webSearch":
      return tool("web_search", item.query ?? null, null, item.status);
    case "imageView":
      return tool("image_view", item.path ?? null, null, item.status);
    default:
      // userMessage / hookPrompt (prompts), contextCompaction, review markers, ...
      return null;
  }
}
