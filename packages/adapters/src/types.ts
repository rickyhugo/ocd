import type { AdapterStatus, HarnessName, PermissionPolicy } from "@ocd/core";

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

export type SessionStatus = "idle" | "busy" | "waiting" | "error" | "missing";

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
  /** Final assistant text of the last completed turn, if any. */
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
  close(): Promise<void>;
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
