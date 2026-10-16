import type {
  AdapterStatus,
  HarnessName,
  HarnessUsage,
  PermissionPolicy,
  ReasoningSummaries,
  TodoItem,
  TranscriptEntry,
  TranscriptSource,
} from "@ocd/core";

/** What an adapter has implemented and tested against a recorded harness version. */
export interface Capabilities {
  start: boolean;
  inspect: boolean;
  steer: boolean;
  interrupt: boolean;
  resume: boolean;
  pendingInteractions: boolean;
  structuredResults: boolean;
  usage: boolean;
  /** Emits `todos` events: the worker's own checklist/plan, as the harness exposes it. */
  todos: boolean;
  /** Read-only recent messages / tool activity (`transcript`). */
  transcript: boolean;
}

export type Capability = keyof Capabilities;

export class UnsupportedCapabilityError extends Error {
  readonly harness: HarnessName;
  readonly capability: Capability;

  constructor(harness: HarnessName, capability: Capability) {
    super(`The ${harness} adapter does not support "${capability}"`);
    this.harness = harness;
    this.capability = capability;
    this.name = "UnsupportedCapabilityError";
  }
}

export interface SessionSpec {
  taskId: string;
  runId: string;
  /** Stable marker embedded in the session title, used to find sessions after a crash. */
  marker: string;
  title: string;
  directory: string;
  model: string;
  agent: string | null;
  permissionPolicy: PermissionPolicy;
  /** Already filtered to the profile's allowlist; includes `isolationEnv`. */
  env: Record<string, string>;
  /**
   * Variables every shell of the worker must see, overriding the harness's
   * own environment: they point `ocd` at a per-task sandbox. Process-owned
   * harnesses get them through `env`; service-owned ones must set them on
   * the session, and must not start a worker without them.
   */
  isolationEnv: Record<string, string>;
}

export interface SessionRef {
  sessionId: string;
}

/**
 * - `idle`: the turn ended and nothing continues the work until a prompt.
 * - `yielded`: the turn ended, but the harness will start the next one itself
 *   (a background subagent or a scheduled wakeup re-invokes the worker), so
 *   the final message is an interim one.
 */
export type SessionStatus = "idle" | "yielded" | "busy" | "waiting" | "error" | "missing";

export interface Interaction {
  /** Harness-native request id; approvals bind to it. */
  id: string;
  kind: "permission" | "question";
  summary: string;
  operation: unknown;
}

export interface SessionSnapshot {
  sessionId: string;
  status: SessionStatus;
  /** Whether the session has received any user prompt. */
  prompted: boolean;
  pending: Interaction[];
  /** Final assistant text of the last completed turn (interim when `yielded`), if any. */
  lastAssistantText: string | null;
  error: string | null;
  /** The harness reports a usage/quota limit, which is a wait, not a failure. */
  quotaLimited: boolean;
}

export type InteractionReply =
  | { type: "approve" }
  | { type: "deny"; message?: string | undefined }
  | { type: "answer"; text: string };

export type AdapterEvent =
  | { type: "activity"; sessionId: string }
  | {
      type: "status";
      sessionId: string;
      status: SessionStatus;
      error?: string;
      quotaLimited?: boolean;
    }
  | { type: "interaction"; sessionId: string; interaction: Interaction }
  | { type: "interaction_resolved"; sessionId: string; interactionId: string }
  /** The whole current checklist (bounded with boundTodos), replacing any earlier one. */
  | { type: "todos"; sessionId: string; todos: TodoItem[] }
  /** The account's subscription usage limits, as the harness reported them (not tied to a task). */
  | { type: "limits"; usage: HarnessUsage }
  | { type: "stream"; state: "connected" | "disconnected" };

export type AdapterListener = (event: AdapterEvent) => void;

export interface HarnessAdapter {
  readonly harness: HarnessName;
  readonly capabilities: Capabilities;
  /** True when sessions are owned by an external service and survive supervisor restarts. */
  readonly sessionsSurviveSupervisor: boolean;

  probe(): Promise<AdapterStatus>;
  subscribe(listener: AdapterListener): () => void;
  createSession(spec: SessionSpec): Promise<SessionRef>;
  /** Looks up a session previously created for this spec's marker. */
  findSession(spec: SessionSpec): Promise<SessionRef | null>;
  prompt(ref: SessionRef, text: string): Promise<void>;
  inspect(ref: SessionRef): Promise<SessionSnapshot>;
  interrupt(ref: SessionRef): Promise<void>;
  reply(ref: SessionRef, interactionId: string, reply: InteractionReply): Promise<void>;
  /**
   * Brings back a session whose worker process is gone (e.g. after a
   * supervisor restart) from the harness's own on-disk state. Process-owned
   * harnesses implement this; service-owned ones never lose sessions.
   */
  revive?(ref: SessionRef, spec: SessionSpec): Promise<void>;
  /**
   * Frees a finished task's worker (e.g. stops its process). Process-owned
   * harnesses implement this; the session may still be revived later.
   */
  release?(ref: SessionRef): Promise<void>;
  /**
   * The command a human runs, in the task's worktree, to drive this session
   * interactively (manual mode), e.g. `claude --resume <id>`.
   */
  interactiveCommand?(ref: SessionRef): string[];
  /**
   * Another process that has this session open (a human's interactive
   * terminal), so OCD must not drive it too. Process-owned harnesses implement
   * this; service-owned sessions can have many clients.
   */
  sessionInUse?(ref: SessionRef): Promise<{ pid: number; command: string } | null>;
  /**
   * Recent visible activity of a session, strictly read-only: it must never
   * start, resume, prompt or otherwise change a worker. Null when the adapter
   * has nothing for the session (e.g. a process-owned session it never saw).
   */
  transcript?(ref: SessionRef, request: TranscriptRequest): Promise<TranscriptPage | null>;
  /**
   * Reads the account's subscription usage limits without a model call (no
   * tokens spent). Only harnesses with such a read implement it; others report
   * limits through `limits` events while they work.
   */
  readLimits?(): Promise<HarnessUsage | null>;
  close(): Promise<void>;
}

export interface TranscriptRequest {
  limit: number;
  /** Adapter cursor from a previous page's `before`. */
  before: string | null;
  reasoningSummaries: boolean;
  signal?: AbortSignal;
}

export interface TranscriptPage {
  source: TranscriptSource;
  /** Oldest first, already redacted and bounded (see sanitizeEntry). */
  entries: TranscriptEntry[];
  /** Adapter cursor for older entries, or null. */
  before: string | null;
  /** Older entries were dropped from a bounded buffer. */
  truncated: boolean;
  reasoningSummaries: ReasoningSummaries;
  notes: string[];
}

/** A cursor that does not belong to this session, or no longer resolves. */
export class InvalidCursorError extends Error {
  constructor(message = "The transcript cursor is invalid or expired; start from the latest page") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function requireCapability(adapter: HarnessAdapter, capability: Capability): void {
  if (!adapter.capabilities[capability])
    throw new UnsupportedCapabilityError(adapter.harness, capability);
}

/**
 * The harness could not be reached, so no request was sent. A launch that
 * fails this way was provably not admitted and may be queued again.
 */
export class HarnessUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessUnavailableError";
  }
}
