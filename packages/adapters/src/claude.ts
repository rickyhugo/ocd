import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

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

// Claude Code worker adapter over print mode with stream-json on stdin and
// stdout. One process per session, kept alive between turns; each turn ends
// with exactly one `result` message. Permission prompts come back over stdio
// (`--permission-prompt-tool stdio`) as `can_use_tool` control requests and
// are answered according to the profile's policy by the supervisor. Workers
// die with the supervisor; `--resume <session id>` continues them later.

export const CLAUDE_TESTED_VERSIONS = ["2.1.296"] as const;

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

const LIMIT_PATTERN = /usage limit|rate.?limit|hit your .*limit|limit resets/i;

/** `model#effort` -> model alias or id, and `--effort` level. */
export function parseClaudeModel(model: string): { model: string; effort: string | null } {
  const [name, effort] = model.split("#", 2);
  return { model: name!, effort: effort ?? null };
}

type ClaudeMessage = {
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
  rate_limit_info?: { status?: string };
};

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

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    this.command = options.command ?? ["claude"];
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
      ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
      "--model",
      model,
      ...(effort ? ["--effort", effort] : []),
      // Always explicit: settings files must not change how permissions are asked.
      "--permission-mode",
      "default",
      "--permission-prompt-tool",
      "stdio",
    ];
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
    } as unknown as ClaudeSession;
    state.proc = new JsonLineProcess(cmd, args, {
      cwd: spec.directory,
      env: spec.env,
      onMessage: (m) => this.onMessage(state, m as ClaudeMessage),
      onInvalidLine: (line) =>
        this.options.onError?.(new Error(line.slice(0, 200)), "claude stdout"),
    });
    void state.proc.exited.then((exit) => this.onExit(state, exit));
    this.sessions.set(session.id, state);
    this.byMarker.set(spec.marker, session.id);
    return state;
  }

  private onMessage(session: ClaudeSession, message: ClaudeMessage): void {
    const sessionId = session.sessionId;
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
        session.status = "waiting";
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
        this.emit({ type: "activity", sessionId });
        return;
      case "rate_limit_event":
        if (message.rate_limit_info?.status === "rejected") session.limitSeen = true;
        return;
      case "result": {
        session.pending.clear();
        const text = typeof message.result === "string" ? message.result : null;
        const failed =
          message.is_error === true ||
          (message.subtype !== undefined && message.subtype !== "success");
        const interrupted =
          message.subtype === "error_during_execution" && session.status === "idle";
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
          if (text) session.lastAssistantText = text;
          session.status = "idle";
          this.emit({ type: "status", sessionId, status: "idle" });
        }
        session.limitSeen = false;
        return;
      }
      default:
        if (message.type === "user" || message.type === "stream_event" || message.type === "system")
          this.emit({ type: "activity", sessionId });
    }
  }

  private onExit(
    session: ClaudeSession,
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    if (this.sessions.get(session.sessionId) !== session) return;
    if (session.status === "busy" || session.status === "waiting") {
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
    if (this.sessions.get(ref.sessionId)?.proc.running) return;
    this.spawn(spec, { id: ref.sessionId, resume: true });
  }

  private live(ref: SessionRef): ClaudeSession {
    const session = this.sessions.get(ref.sessionId);
    if (!session?.proc.running)
      throw new Error(`Claude session ${ref.sessionId} has no running worker`);
    return session;
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    const session = this.live(ref);
    session.proc.send({
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
    session.prompted = true;
    session.error = null;
    session.quotaLimited = false;
    if (session.status !== "waiting") session.status = "busy";
  }

  async inspect(ref: SessionRef): Promise<SessionSnapshot> {
    const session = this.sessions.get(ref.sessionId);
    if (!session || (!session.proc.running && session.status !== "error")) {
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
    if (!session?.proc.running || session.status === "idle") return;
    session.status = "idle"; // the turn's result arrives as an interrupted execution
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
    await Promise.all([...this.sessions.values()].map((s) => s.proc.stop(2000)));
    this.sessions.clear();
    this.byMarker.clear();
    this.listeners.clear();
  }
}
