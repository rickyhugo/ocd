import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { textEntry, toolEntry, type AdapterStatus } from "@ocd/core";

import {
  ClaudeBackgroundWork,
  SESSION_STATE_ENV,
  type ClaudeBackgroundMessage,
} from "./claude-background.ts";
import { ClaudeTodoTracker } from "./claude-todos.ts";
import { processMentioning } from "./processes.ts";
import { JsonLineProcess } from "./jsonl-process.ts";
import { TranscriptStore, type TranscriptBufferLimits } from "./transcript-buffer.ts";
import { claudeUsage, type ClaudeRateLimitInfo } from "./usage-limits.ts";
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

// Claude Code worker adapter over print mode with stream-json on stdin and
// stdout. One process per session, kept alive between turns; each turn ends
// with exactly one `result` message, and yields rather than goes idle while
// Claude Code will start the next turn itself (claude-background.ts).
// Permission prompts come back over stdio (`--permission-prompt-tool stdio`)
// as `can_use_tool` control requests and are answered according to the
// profile's policy by the supervisor. Workers die with the supervisor;
// `--resume <session id>` continues them later.

export const CLAUDE_TESTED_VERSIONS = ["2.1.296", "2.1.299"] as const;

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

const LIMIT_PATTERN = /usage limit|rate.?limit|hit your .*limit|limit resets/i;

/** `model#effort` -> model alias or id, and `--effort` level. */
export function parseClaudeModel(model: string): { model: string; effort: string | null } {
  const [name, effort] = model.split("#", 2);
  return { model: name!, effort: effort ?? null };
}

type ClaudeMessage = ClaudeBackgroundMessage & {
  type?: string;
  subtype?: string;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    decision_reason?: string;
    description?: string;
  };
  response?: { subtype?: string; request_id?: string; error?: string };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  api_error_status?: number | null;
  error?: string;
  rate_limit_info?: ClaudeRateLimitInfo;
  uuid?: string;
  /** A user message echoed back by --replay-user-messages as it is consumed. */
  isReplay?: boolean;
  message?: { id?: string; role?: string; content?: unknown };
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

/** Text of a tool_result's content: a string or an array of text/image blocks. */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((c: ContentBlock) =>
      c?.type === "text" && typeof c.text === "string" ? c.text : `[${String(c?.type)}]`,
    )
    .join("\n");
}

interface ClaudeSession {
  sessionId: string;
  spec: SessionSpec;
  proc: JsonLineProcess;
  status: SessionSnapshot["status"];
  prompted: boolean;
  pending: Map<
    string,
    Interaction & { requestId: string; input: Record<string, unknown>; toolUseId: string | null }
  >;
  lastAssistantText: string | null;
  error: string | null;
  quotaLimited: boolean;
  limitSeen: boolean;
  /** The process was stopped while idle; the session resumes on the next prompt. */
  parked: boolean;
  /** The in-flight stop of an idle worker; a prompt waits for it, then restarts. */
  stopping: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  todos: ClaudeTodoTracker;
  /** The current process's work that outlives a turn. */
  background: ClaudeBackgroundWork;
  /** Fallback transcript keys for messages without uuid or id. */
  observed: number;
  /**
   * User messages sent to the current process that Claude Code has not picked
   * up yet. With --replay-user-messages it echoes each one when it consumes
   * it: a message sent mid-turn is either folded into the running turn (echoed
   * before that turn's result) or queued for a turn of its own (echoed after).
   * A result ends the work only when nothing is left unconsumed.
   */
  unconsumed: number;
  /** Interrupts whose aborted turn has not reported its result yet. */
  interrupts: number;
}

function summarize(tool: string, input: Record<string, unknown>): string {
  const value =
    input["command"] ?? input["file_path"] ?? input["path"] ?? input["url"] ?? input["pattern"];
  return typeof value === "string" ? `${tool}: ${value}` : tool;
}

export interface ClaudeAdapterOptions {
  /** Executable; defaults to `claude`. Extra leading args are allowed (tests). */
  command?: [string, ...string[]];
  onError?: (error: unknown, context: string) => void;
  /** Stop a worker process after this long idle; its session resumes on demand. */
  idleStopMs?: number;
  transcriptLimits?: Partial<TranscriptBufferLimits>;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly harness = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessionsSurviveSupervisor = false;

  private readonly command: [string, ...string[]];
  private readonly options: ClaudeAdapterOptions;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly byMarker = new Map<string, string>();
  private readonly listeners = new Set<AdapterListener>();
  private readonly transcripts: TranscriptStore;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    this.command = options.command ?? ["claude"];
    this.transcripts = new TranscriptStore(options.transcriptLimits);
  }

  private run(args: string[]): Promise<{ ok: boolean; stdout: string }> {
    const [cmd, ...prefix] = this.command;
    return new Promise((resolve) => {
      execFile(cmd, [...prefix, ...args], { timeout: 15_000 }, (error, stdout) =>
        resolve({ ok: !error, stdout: String(stdout) }),
      );
    });
  }

  async probe(): Promise<AdapterStatus> {
    const version = await this.run(["--version"]);
    if (!version.ok) {
      return {
        harness: "claude",
        available: false,
        version: null,
        problems: [`${this.command[0]} not found or not runnable`],
      };
    }
    const v = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] ?? version.stdout.trim();
    const problems: string[] = [];
    if (!(CLAUDE_TESTED_VERSIONS as readonly string[]).includes(v)) {
      problems.push(
        `Claude Code ${v} is untested; the adapter targets ${CLAUDE_TESTED_VERSIONS.join(", ")}`,
      );
    }
    const auth = await this.run(["auth", "status", "--json"]);
    if (!auth.ok) problems.push("Claude Code is not logged in (run `claude` and /login)");
    return { harness: "claude", available: auth.ok, version: v, problems };
  }

  subscribe(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private spawn(spec: SessionSpec, session: { id: string; resume: boolean }): ClaudeSession {
    const state = {
      sessionId: session.id,
      spec,
      status: "idle",
      prompted: session.resume,
      pending: new Map(),
      lastAssistantText: null,
      error: null,
      quotaLimited: false,
      limitSeen: false,
      parked: false,
      stopping: null,
      idleTimer: null,
      todos: new ClaudeTodoTracker(),
      observed: 0,
      unconsumed: 0,
      interrupts: 0,
    } as unknown as ClaudeSession;
    this.startProcess(state, session.resume);
    this.sessions.set(session.id, state);
    this.byMarker.set(spec.marker, session.id);
    return state;
  }

  /** Starts (or restarts, with --resume) the worker process for a session. */
  private startProcess(state: ClaudeSession, resume: boolean): void {
    const spec = state.spec;
    const { model, effort } = parseClaudeModel(spec.model);
    const [cmd, ...prefix] = this.command;
    const args = [
      ...prefix,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      // Echoes each user message when it is consumed; see ClaudeSession.unconsumed.
      "--replay-user-messages",
      ...(resume ? ["--resume", state.sessionId] : ["--session-id", state.sessionId]),
      "--model",
      model,
      ...(effort ? ["--effort", effort] : []),
      // Always explicit, so settings files cannot change how permissions work.
      // yolo skips checks entirely; the few prompts Claude Code still raises
      // (protected config/git files) come over stdio and OCD approves them.
      ...(spec.permissionPolicy === "yolo"
        ? ["--dangerously-skip-permissions"]
        : ["--permission-mode", "default"]),
      "--permission-prompt-tool",
      "stdio",
    ];
    const proc = new JsonLineProcess(cmd, args, {
      cwd: spec.directory,
      env: { ...spec.env, ...SESSION_STATE_ENV },
      onMessage: (m) => this.onMessage(state, m as ClaudeMessage),
      onError: (error) => this.options.onError?.(error, "claude message"),
      onInvalidLine: (line) =>
        this.options.onError?.(new Error(line.slice(0, 200)), "claude stdout"),
    });
    state.proc = proc;
    state.parked = false;
    // A new process has nothing in flight.
    state.unconsumed = 0;
    state.interrupts = 0;
    state.background = new ClaudeBackgroundWork();
    // Ignore exits of a process that has since been replaced.
    void proc.exited.then((exit) => {
      if (state.proc === proc) this.onExit(state, exit);
    });
  }

  private scheduleIdleStop(session: ClaudeSession): void {
    this.clearIdleStop(session);
    const ms = this.options.idleStopMs ?? 10 * 60_000;
    session.idleTimer = setTimeout(() => void this.park(session), ms);
    session.idleTimer.unref();
  }

  private clearIdleStop(session: ClaudeSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  /** Stops an idle worker process; the session stays resumable from disk. */
  private async park(session: ClaudeSession): Promise<void> {
    this.clearIdleStop(session);
    if (!session.proc.running || session.status === "busy" || session.status === "waiting") return;
    session.parked = true;
    // Tracked so a prompt arriving while the process winds down waits for it
    // and restarts, instead of writing to a closed stdin.
    const stopping = session.proc.stop(2000).finally(() => {
      if (session.stopping === stopping) session.stopping = null;
    });
    session.stopping = stopping;
    await stopping;
  }

  private onMessage(session: ClaudeSession, message: ClaudeMessage): void {
    const sessionId = session.sessionId;
    try {
      const todos = session.todos.observe(message);
      if (todos) this.emit({ type: "todos", sessionId, todos });
    } catch (error) {
      this.options.onError?.(error, "claude todos");
    }
    session.background.observe(message);
    switch (message.type) {
      case "control_request": {
        if (message.request?.subtype !== "can_use_tool" || !message.request_id) return;
        const id = `perm:${message.request_id}`;
        if (session.pending.has(id)) return; // re-sent after reconnect
        const tool = message.request.tool_name ?? "tool";
        const input = message.request.input ?? {};
        const interaction = {
          id,
          kind: "permission" as const,
          summary: summarize(tool, input),
          operation: {
            tool,
            input,
            reason: message.request.decision_reason ?? message.request.description ?? null,
          },
        };
        session.pending.set(id, {
          ...interaction,
          requestId: message.request_id,
          input,
          toolUseId: message.request.tool_use_id ?? null,
        });
        // A background subagent can ask after the worker's own turn has ended.
        if (session.status !== "yielded") session.status = "waiting";
        this.emit({ type: "interaction", sessionId, interaction });
        return;
      }
      case "control_cancel_request": {
        const id = `perm:${message.request_id}`;
        if (session.pending.delete(id)) {
          if (session.status === "waiting" && session.pending.size === 0) session.status = "busy";
          this.emit({ type: "interaction_resolved", sessionId, interactionId: id });
        }
        return;
      }
      case "assistant":
        if (message.error === "rate_limit" || message.error === "billing_error")
          session.limitSeen = true;
        this.record(session, message);
        this.emit({ type: "activity", sessionId });
        return;
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        if (!info) return;
        if (info.status === "rejected") session.limitSeen = true;
        // The account's limits, not this task's: Claude Code sends them with every turn.
        try {
          this.emit({ type: "limits", usage: claudeUsage(info, new Date().toISOString()) });
        } catch (error) {
          this.options.onError?.(error, "claude limits");
        }
        return;
      }
      case "result": {
        const text = typeof message.result === "string" ? message.result : null;
        const failed =
          message.is_error === true ||
          (message.subtype !== undefined && message.subtype !== "success");
        const yielded = !failed && session.background.continues(Date.now());
        // Once the worker's own turn is over, only its background work can still be asking.
        if (!yielded) session.pending.clear();
        // The next result after an interrupt belongs to the aborted turn, even
        // when a new prompt was sent before it arrived.
        const interrupted = session.interrupts > 0 && message.subtype === "error_during_execution";
        if (session.interrupts > 0) session.interrupts -= 1;
        if (interrupted && session.unconsumed > 0) {
          // The follow-up sent after the interrupt is still running.
          this.emit({ type: "activity", sessionId });
          return;
        }
        if (!failed && session.unconsumed > 0) {
          // A message sent mid-turn is still queued: this result is not the end.
          if (text) session.lastAssistantText = text;
          this.emit({ type: "activity", sessionId });
          return;
        }
        if (failed && !interrupted) {
          session.error =
            text ?? message.errors?.join("; ") ?? message.subtype ?? "Claude Code turn failed";
          session.quotaLimited =
            session.limitSeen ||
            message.api_error_status === 429 ||
            LIMIT_PATTERN.test(session.error);
          session.status = "error";
          this.emit({
            type: "status",
            sessionId,
            status: "error",
            error: session.error,
            quotaLimited: session.quotaLimited,
          });
        } else {
          if (text && !interrupted) session.lastAssistantText = text;
          session.status = yielded ? "yielded" : "idle";
          this.emit({ type: "status", sessionId, status: session.status });
        }
        session.limitSeen = false;
        // Stopping the process would end the background work that continues the session.
        if (!yielded) this.scheduleIdleStop(session);
        return;
      }
      case "system":
        if (message.subtype === "session_state_changed" && session.status === "yielded")
          this.settleYield(session, message.state);
        this.emit({ type: "activity", sessionId });
        return;
      default:
        if (message.type === "user" && message.isReplay) {
          // OCD's own prompt, now being worked on; not part of the transcript.
          session.unconsumed = Math.max(0, session.unconsumed - 1);
          this.emit({ type: "activity", sessionId });
          return;
        }
        if (message.type === "user") this.record(session, message);
        if (message.type === "user" || message.type === "stream_event")
          this.emit({ type: "activity", sessionId });
    }
  }

  /** A yielded session either runs a turn Claude Code started itself, or its work is over. */
  private settleYield(session: ClaudeSession, state: unknown): void {
    if (state === "running") {
      session.status = "busy";
    } else if (state === "idle" && !session.background.continues(Date.now())) {
      session.status = "idle";
      session.pending.clear();
      this.scheduleIdleStop(session);
    } else return;
    this.emit({ type: "status", sessionId: session.sessionId, status: session.status });
  }

  /**
   * Keeps the visible parts of complete assistant/user messages: assistant
   * text, tool_use blocks, and the tool_result blocks Claude Code sends back
   * as user messages (merged into their tool call by tool_use_id). Prompts
   * (user text), thinking/redacted_thinking blocks and partial stream events
   * are never kept.
   */
  private record(session: ClaudeSession, message: ClaudeMessage): void {
    if (this.sessions.get(session.sessionId) !== session) return;
    const blocks = message.message?.content;
    if (!Array.isArray(blocks)) return;
    try {
      const buffer = this.transcripts.live(session.sessionId);
      const at = new Date().toISOString();
      const messageKey = message.uuid ?? message.message?.id ?? `n${(session.observed += 1)}`;
      blocks.forEach((raw: ContentBlock, index) => {
        if (!raw || typeof raw !== "object") return;
        if (message.type === "assistant" && raw.type === "text" && typeof raw.text === "string") {
          if (raw.text.trim()) buffer.upsert(textEntry(`${messageKey}:${index}`, at, raw.text));
        } else if (
          message.type === "assistant" &&
          raw.type === "tool_use" &&
          typeof raw.id === "string"
        ) {
          const previous = buffer.get(`tool:${raw.id}`)?.tool;
          buffer.upsert(
            toolEntry({
              id: `tool:${raw.id}`,
              at,
              name: typeof raw.name === "string" ? raw.name : "tool",
              callId: raw.id,
              status: previous?.status ?? "running",
              input: raw.input ?? null,
              output: previous?.output ?? null,
            }),
          );
        } else if (
          message.type === "user" &&
          raw.type === "tool_result" &&
          typeof raw.tool_use_id === "string"
        ) {
          const id = `tool:${raw.tool_use_id}`;
          const call = buffer.get(id);
          const result = toolEntry({
            id,
            at: call?.at ?? at,
            name: call?.tool?.name ?? "tool",
            callId: raw.tool_use_id,
            status: raw.is_error === true ? "error" : "completed",
            output: toolResultText(raw.content),
          });
          buffer.upsert(
            call?.tool
              ? {
                  ...result,
                  tool: { ...result.tool!, input: call.tool.input },
                  truncated: result.truncated || call.truncated,
                }
              : result,
          );
        }
        // thinking / redacted_thinking: private reasoning, never collected.
      });
    } catch (error) {
      this.options.onError?.(error, "claude transcript");
    }
  }

  private onExit(
    session: ClaudeSession,
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    // Whatever the dead process was waiting on will never be answered.
    session.pending.clear();
    if (this.sessions.get(session.sessionId) !== session || session.parked) return;
    if (session.status === "busy" || session.status === "waiting" || session.status === "yielded") {
      session.error = `claude exited (${exit.signal ?? exit.code}): ${session.proc.stderr().slice(-500)}`;
      session.status = "error";
      this.emit({
        type: "status",
        sessionId: session.sessionId,
        status: "error",
        error: session.error,
      });
    }
  }

  async createSession(spec: SessionSpec): Promise<SessionRef> {
    const id = randomUUID();
    const session = this.spawn(spec, { id, resume: false });
    // Fail fast on a missing binary or bad flags instead of at the first prompt.
    const early = await Promise.race([
      session.proc.exited,
      new Promise<null>((r) => setTimeout(() => r(null), 300)),
    ]);
    if (early) {
      this.sessions.delete(id);
      if (this.byMarker.get(spec.marker) === id) this.byMarker.delete(spec.marker);
      throw new HarnessUnavailableError(
        `claude did not start: ${session.proc.stderr().trim() || `exit ${early.code}`}`,
      );
    }
    return { sessionId: id };
  }

  async findSession(spec: SessionSpec): Promise<SessionRef | null> {
    const id = this.byMarker.get(spec.marker);
    return id ? { sessionId: id } : null;
  }

  async revive(ref: SessionRef, spec: SessionSpec): Promise<void> {
    const existing = this.sessions.get(ref.sessionId);
    if (existing?.proc.running) return;
    if (existing) this.startProcess(existing, true);
    else this.spawn(spec, { id: ref.sessionId, resume: true });
  }

  /** Ends a finished task's worker. A later reattach can still resume it from disk. */
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
   * What this adapter saw the worker do, from memory only: never starts or
   * resumes a process, so a parked, released or unknown session is read as is.
   * Claude Code's stream-json has no documented reasoning-summary field
   * (thinking blocks may be full reasoning), so summaries are unsupported.
   */
  async transcript(ref: SessionRef, request: TranscriptRequest): Promise<TranscriptPage | null> {
    return this.transcripts.read(ref.sessionId, request, "unsupported");
  }

  interactiveCommand(ref: SessionRef): string[] {
    return [this.command[0], "--resume", ref.sessionId];
  }

  async sessionInUse(ref: SessionRef): Promise<{ pid: number; command: string } | null> {
    // Our own worker for this session counts only while OCD drives it.
    if (this.sessions.get(ref.sessionId)?.proc.running) return null;
    return processMentioning(ref.sessionId);
  }

  /** Number of running worker processes (for status and tests). */
  activeWorkers(): number {
    return [...this.sessions.values()].filter((s) => s.proc.running).length;
  }

  private live(ref: SessionRef): ClaudeSession {
    const session = this.sessions.get(ref.sessionId);
    if (!session?.proc.running)
      throw new Error(`Claude session ${ref.sessionId} has no running worker`);
    return session;
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    let parked = this.sessions.get(ref.sessionId);
    if (parked?.stopping) {
      await parked.stopping;
      parked = this.sessions.get(ref.sessionId); // may have been released meanwhile
    }
    if (parked && !parked.proc.running && (parked.parked || parked.status !== "busy")) {
      this.startProcess(parked, true);
    }
    const session = this.live(ref);
    this.clearIdleStop(session);
    session.proc.send({
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
    session.prompted = true;
    session.unconsumed += 1;
    session.error = null;
    session.quotaLimited = false;
    if (session.status !== "waiting") session.status = "busy";
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
        ({ requestId: _r, input: _i, toolUseId: _t, ...interaction }) => interaction,
      ),
      lastAssistantText: session.lastAssistantText,
      error: session.error,
      quotaLimited: session.quotaLimited,
    };
  }

  async interrupt(ref: SessionRef): Promise<void> {
    const session = this.sessions.get(ref.sessionId);
    // A yielded session has no turn to abort; releasing it stops its background work.
    if (!session?.proc.running || session.status === "idle" || session.status === "yielded") return;
    // The turn's result arrives as an interrupted execution; it is not a failure.
    session.interrupts += 1;
    session.status = "idle";
    session.pending.clear();
    session.proc.send({
      type: "control_request",
      request_id: `ocd-int-${randomUUID()}`,
      request: { subtype: "interrupt" },
    });
  }

  async reply(ref: SessionRef, interactionId: string, reply: InteractionReply): Promise<void> {
    const session = this.live(ref);
    const pending = session.pending.get(interactionId);
    if (!pending) throw new Error(`No pending Claude Code request ${interactionId}`);
    if (reply.type === "answer")
      throw new Error("Claude Code permission requests take approve or deny");
    const response =
      reply.type === "approve"
        ? {
            behavior: "allow",
            updatedInput: pending.input,
            ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
          }
        : {
            behavior: "deny",
            message: reply.message ?? "Denied by the OCD supervisor.",
            ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
          };
    session.proc.send({
      type: "control_response",
      response: { subtype: "success", request_id: pending.requestId, response },
    });
    session.pending.delete(interactionId);
    if (session.pending.size === 0 && session.status === "waiting") session.status = "busy";
    this.emit({ type: "interaction_resolved", sessionId: ref.sessionId, interactionId });
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
