import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { boundTodos, textEntry, toolEntry, type AdapterStatus, type TodoItem } from "@ocd/core";

import { TranscriptStore } from "./transcript-buffer.ts";
import type {
  AdapterEvent,
  AdapterListener,
  Capabilities,
  HarnessAdapter,
  Interaction,
  InteractionReply,
  SessionRef,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
  TranscriptPage,
  TranscriptRequest,
} from "./types.ts";

// A scriptable in-process harness for tests and dry runs. It performs real file
// writes in the workspace so workspace preservation can be tested, but never
// calls a model.

export type FakeStep =
  | { type: "write"; file: string; content: string }
  | { type: "permission"; summary: string; operation: unknown }
  | { type: "question"; summary: string }
  | { type: "reply"; text: string }
  | { type: "error"; message: string; quota?: boolean }
  | { type: "hang" }
  | { type: "wait"; ms: number }
  | { type: "todos"; todos: TodoItem[] };

export type FakeScript = (prompt: string, spec: SessionSpec) => FakeStep[];

export type FaultPoint = "createSession" | "prompt";
export type FaultTiming = "before" | "after";

export class SimulatedFault extends Error {
  readonly point: FaultPoint;
  readonly timing: FaultTiming;

  constructor(point: FaultPoint, timing: FaultTiming) {
    super(`Simulated fault ${timing} ${point}`);
    this.point = point;
    this.timing = timing;
    this.name = "SimulatedFault";
  }
}

interface PendingInteraction extends Interaction {
  settle: (reply: InteractionReply) => void;
}

interface FakeSession {
  id: string;
  spec: SessionSpec;
  status: SessionStatus;
  prompts: string[];
  pending: Map<string, PendingInteraction>;
  lastAssistantText: string | null;
  error: string | null;
  quotaLimited: boolean;
  abort: AbortController | null;
}

export function fakeReport(summary: string, changedFiles: string[]): string {
  const report = {
    summary,
    changedFiles,
    tests: [{ command: "fake-check", outcome: "passed" }],
    unresolved: [],
  };
  return `Done.\n\n\`\`\`ocd-report\n${JSON.stringify(report)}\n\`\`\``;
}

/** Directive-driven default script: include e.g. `[fake:permission]` in the instructions. */
export const defaultFakeScript: FakeScript = (prompt) => {
  const file = "ocd-fake.txt";
  const work: FakeStep[] = [{ type: "write", file, content: `${prompt.slice(0, 200)}\n` }];
  const done: FakeStep = { type: "reply", text: fakeReport("Wrote ocd-fake.txt", [file]) };
  if (prompt.includes("[fake:hang]")) return [{ type: "hang" }];
  if (prompt.includes("[fake:todos]")) {
    const todos = (done: number): FakeStep => ({
      type: "todos",
      todos: ["Read the code", "Make the change", "Run the tests"].map((text, i) => ({
        text,
        status: i < done ? "completed" : i === done ? "in_progress" : "pending",
      })),
    });
    return [todos(0), todos(1), { type: "hang" }];
  }
  if (prompt.includes("[fake:error]")) return [{ type: "error", message: "Fake harness error" }];
  if (prompt.includes("[fake:quota]"))
    return [{ type: "error", message: "Usage limit reached", quota: true }];
  if (prompt.includes("[fake:no-report]"))
    return [...work, { type: "reply", text: "All done, trust me." }];
  if (prompt.includes("[fake:question]"))
    return [{ type: "question", summary: "Which approach?" }, ...work, done];
  if (prompt.includes("[fake:permission]")) {
    return [
      {
        type: "permission",
        summary: "Run `rm -rf build`",
        operation: { tool: "bash", command: "rm -rf build" },
      },
      ...work,
      done,
    ];
  }
  return [...work, done];
};

/** Shared harness state. Reusing it across adapter instances simulates a service that outlives the supervisor. */
export class FakeHarnessState {
  readonly sessions = new Map<string, FakeSession>();
  /** Sessions whose process died but whose transcript a harness could resume from disk. */
  readonly onDisk = new Map<string, FakeSession>();
  readonly listeners = new Set<AdapterListener>();
  createdCount = 0;
  promptCount = 0;
  /** Sessions a pretend interactive terminal has open (manual mode tests). */
  readonly inUse = new Set<string>();
  /** Prompt texts in order, for assertions. */
  readonly prompts: string[] = [];
  /** Transcript reads, and a fault to simulate on the next ones. */
  transcriptReads = 0;
  transcriptFault: "error" | "hang" | null = null;

  emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export interface FakeAdapterOptions {
  state?: FakeHarnessState;
  script?: FakeScript;
  stepDelayMs?: number;
  /** Sessions survive close() (service-owned) instead of being killed with the supervisor. */
  survive?: boolean;
  faults?: Partial<Record<FaultPoint, FaultTiming>>;
  available?: boolean;
}

const CAPABILITIES: Capabilities = { todos: true };

export class FakeAdapter implements HarnessAdapter {
  readonly harness = "fake" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessionsSurviveSupervisor: boolean;
  readonly state: FakeHarnessState;
  private readonly script: FakeScript;
  private readonly stepDelayMs: number;
  private readonly faults: Partial<Record<FaultPoint, FaultTiming>>;
  private readonly available: boolean;
  private readonly ownListeners = new Set<AdapterListener>();
  /** Like Claude Code / Codex: what this instance saw, in memory only. */
  private readonly transcripts = new TranscriptStore();

  constructor(options: FakeAdapterOptions = {}) {
    this.state = options.state ?? new FakeHarnessState();
    this.script = options.script ?? defaultFakeScript;
    this.stepDelayMs = options.stepDelayMs ?? 5;
    this.sessionsSurviveSupervisor = options.survive ?? false;
    this.faults = { ...options.faults };
    this.available = options.available ?? true;
  }

  async probe(): Promise<AdapterStatus> {
    return {
      harness: "fake",
      available: this.available,
      version: "fake-1",
      problems: this.available ? [] : ["Fake harness marked unavailable"],
    };
  }

  subscribe(listener: AdapterListener): () => void {
    this.state.listeners.add(listener);
    this.ownListeners.add(listener);
    return () => {
      this.state.listeners.delete(listener);
      this.ownListeners.delete(listener);
    };
  }

  private fault(point: FaultPoint, timing: FaultTiming): void {
    if (this.faults[point] === timing) {
      delete this.faults[point];
      throw new SimulatedFault(point, timing);
    }
  }

  async createSession(spec: SessionSpec): Promise<SessionRef> {
    this.fault("createSession", "before");
    const id = `fake_${randomBytes(5).toString("hex")}`;
    this.state.sessions.set(id, {
      id,
      spec,
      status: "idle",
      prompts: [],
      pending: new Map(),
      lastAssistantText: null,
      error: null,
      quotaLimited: false,
      abort: null,
    });
    this.state.createdCount += 1;
    this.fault("createSession", "after");
    return { sessionId: id };
  }

  async findSession(spec: SessionSpec): Promise<SessionRef | null> {
    for (const session of this.state.sessions.values()) {
      if (session.spec.marker === spec.marker) return { sessionId: session.id };
    }
    return null;
  }

  private session(ref: SessionRef): FakeSession {
    const session = this.state.sessions.get(ref.sessionId);
    if (!session) throw new Error(`Fake session ${ref.sessionId} not found`);
    return session;
  }

  private setStatus(session: FakeSession, status: SessionStatus): void {
    session.status = status;
    this.state.emit({
      type: "status",
      sessionId: session.id,
      status,
      ...(session.error ? { error: session.error } : {}),
      ...(session.quotaLimited ? { quotaLimited: true } : {}),
    });
  }

  async prompt(ref: SessionRef, text: string): Promise<void> {
    const session = this.session(ref);
    this.fault("prompt", "before");
    session.prompts.push(text);
    this.state.prompts.push(text);
    this.state.promptCount += 1;
    session.abort?.abort();
    const abort = new AbortController();
    session.abort = abort;
    session.error = null;
    session.quotaLimited = false;
    this.setStatus(session, "busy");
    void this.run(session, this.script(text, session.spec), abort.signal);
    this.fault("prompt", "after");
  }

  private async run(session: FakeSession, steps: FakeStep[], signal: AbortSignal): Promise<void> {
    try {
      for (const [index, step] of steps.entries()) {
        // Stable per prompt and step, like a harness item id.
        const itemId = `${session.prompts.length}:${index}`;
        await delay(this.stepDelayMs, undefined, { signal });
        this.state.emit({ type: "activity", sessionId: session.id });
        switch (step.type) {
          case "wait":
            await delay(step.ms, undefined, { signal });
            break;
          case "write": {
            const target = join(session.spec.directory, step.file);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, step.content);
            this.transcripts.live(session.id).upsert(
              toolEntry({
                id: `tool:${itemId}`,
                at: new Date().toISOString(),
                name: "write",
                callId: null,
                status: "completed",
                input: { file: step.file },
                output: `${step.content.length} chars`,
              }),
            );
            break;
          }
          case "permission":
          case "question": {
            const reply = await this.ask(session, step, signal);
            if (reply.type === "deny") {
              session.lastAssistantText = `Stopped: ${step.type} was denied.`;
              this.setStatus(session, "idle");
              return;
            }
            break;
          }
          case "reply":
            session.lastAssistantText = step.text;
            this.transcripts
              .live(session.id)
              .upsert(textEntry(`msg:${itemId}`, new Date().toISOString(), step.text));
            break;
          case "todos":
            this.state.emit({
              type: "todos",
              sessionId: session.id,
              todos: boundTodos(step.todos),
            });
            break;
          case "error":
            session.error = step.message;
            session.quotaLimited = step.quota ?? false;
            this.setStatus(session, "error");
            return;
          case "hang":
            await new Promise<never>((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason)),
            );
            break;
        }
      }
      this.setStatus(session, "idle");
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  private ask(
    session: FakeSession,
    step: Extract<FakeStep, { type: "permission" | "question" }>,
    signal: AbortSignal,
  ): Promise<InteractionReply> {
    const id = `${step.type === "permission" ? "perm" : "q"}_${randomBytes(4).toString("hex")}`;
    return new Promise<InteractionReply>((resolve, reject) => {
      const interaction: PendingInteraction = {
        id,
        kind: step.type,
        summary: step.summary,
        operation: step.type === "permission" ? step.operation : { question: step.summary },
        settle: (reply) => {
          session.pending.delete(id);
          this.state.emit({
            type: "interaction_resolved",
            sessionId: session.id,
            interactionId: id,
          });
          if (session.status === "waiting") this.setStatus(session, "busy");
          resolve(reply);
        },
      };
      session.pending.set(id, interaction);
      this.setStatus(session, "waiting");
      const { settle: _settle, ...publicInteraction } = interaction;
      this.state.emit({
        type: "interaction",
        sessionId: session.id,
        interaction: publicInteraction,
      });
      signal.addEventListener("abort", () => {
        session.pending.delete(id);
        reject(signal.reason);
      });
    });
  }

  async inspect(ref: SessionRef): Promise<SessionSnapshot> {
    const session = this.state.sessions.get(ref.sessionId);
    if (!session) {
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
      sessionId: session.id,
      status: session.status,
      prompted: session.prompts.length > 0,
      pending: [...session.pending.values()].map(({ settle: _settle, ...rest }) => rest),
      lastAssistantText: session.lastAssistantText,
      error: session.error,
      quotaLimited: session.quotaLimited,
    };
  }

  async interrupt(ref: SessionRef): Promise<void> {
    const session = this.session(ref);
    session.abort?.abort(new Error("interrupted"));
    session.abort = null;
    session.pending.clear();
    if (session.status !== "idle") this.setStatus(session, "idle");
  }

  async reply(ref: SessionRef, interactionId: string, reply: InteractionReply): Promise<void> {
    const pending = this.session(ref).pending.get(interactionId);
    if (!pending)
      throw new Error(`No pending interaction ${interactionId} in session ${ref.sessionId}`);
    pending.settle(reply);
  }

  /** Pretend the stream dropped and came back; consumers must reconcile. */
  simulateReconnect(): void {
    this.state.emit({ type: "stream", state: "disconnected" });
    this.state.emit({ type: "stream", state: "connected" });
  }

  async transcript(ref: SessionRef, request: TranscriptRequest): Promise<TranscriptPage | null> {
    this.state.transcriptReads += 1;
    if (this.state.transcriptFault === "error") throw new Error("fake transcript failure");
    if (this.state.transcriptFault === "hang")
      await new Promise((_, reject) =>
        request.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    return this.transcripts.read(ref.sessionId, request, "unsupported");
  }

  async close(): Promise<void> {
    this.transcripts.clear();
    for (const listener of this.ownListeners) this.state.listeners.delete(listener);
    this.ownListeners.clear();
    if (this.sessionsSurviveSupervisor) return;
    // CLI-owned workers die with their control pipes.
    for (const session of this.state.sessions.values()) {
      session.abort?.abort(new Error("supervisor exited"));
      session.abort = null;
      session.pending.clear();
      session.status = "idle";
      this.state.onDisk.set(session.id, session);
      this.state.sessions.delete(session.id);
    }
  }

  /** Stops a process-owned session's worker; it stays revivable from "disk". */
  async release(ref: SessionRef): Promise<void> {
    if (this.sessionsSurviveSupervisor) return;
    const session = this.state.sessions.get(ref.sessionId);
    if (!session) return;
    session.abort?.abort(new Error("released"));
    session.abort = null;
    session.pending.clear();
    session.status = "idle";
    this.state.onDisk.set(session.id, session);
    this.state.sessions.delete(session.id);
    this.transcripts.release(session.id);
  }

  interactiveCommand(ref: SessionRef): string[] {
    return ["fake-harness", "--resume", ref.sessionId];
  }

  async sessionInUse(ref: SessionRef): Promise<{ pid: number; command: string } | null> {
    return this.state.inUse.has(ref.sessionId)
      ? { pid: 4242, command: `fake-harness --resume ${ref.sessionId}` }
      : null;
  }

  /** Like `claude --resume`: restores a session from "disk" in a new process. */
  async revive(ref: SessionRef): Promise<void> {
    const session = this.state.onDisk.get(ref.sessionId);
    if (!session) throw new Error(`No resumable fake session ${ref.sessionId}`);
    this.state.onDisk.delete(ref.sessionId);
    this.state.sessions.set(session.id, session);
  }
}
