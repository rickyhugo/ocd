import { z } from "zod";

import { TASK_STATES } from "./states.ts";

// Wire contracts shared by the supervisor API, the CLI, and the plugin. Inputs
// are validated at every boundary; outputs are typed for clients.

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "Use lowercase letters, digits, '.', '_' or '-' (max 63)");

export const HarnessName = z.enum(["opencode", "claude", "codex", "fake"]);
export type HarnessName = z.infer<typeof HarnessName>;

export const PermissionPolicy = z.enum(["deny", "ask"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const Actor = z.enum(["human", "manager"]);
export type Actor = z.infer<typeof Actor>;

export const TaskStateSchema = z.enum(TASK_STATES);

const EnvVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Environment variable names only");

// ---------------------------------------------------------------------------
// Repositories and profiles (human-configured allowlists)

export const RepositoryInput = z.object({
  name: Slug,
  path: z.string().min(1),
  defaultProfile: Slug.optional(),
  baseRef: z.string().min(1).max(200).optional(),
  /** argv of an independent verification command run in the workspace. */
  verifyCommand: z.array(z.string().min(1)).min(1).max(32).optional(),
});
export type RepositoryInput = z.infer<typeof RepositoryInput>;

export interface Repository {
  id: string;
  name: string;
  path: string;
  defaultProfile: string | null;
  baseRef: string | null;
  verifyCommand: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export const ProfileInput = z.object({
  name: Slug,
  harness: HarnessName,
  /** Harness model id, for OpenCode `provider/model`. */
  model: z.string().min(1).max(200),
  agent: z.string().min(1).max(100).optional(),
  instructions: z.string().max(8000).optional(),
  permissionPolicy: PermissionPolicy.default("deny"),
  envAllowlist: z.array(EnvVarName).max(50).default([]),
});
export type ProfileInput = z.input<typeof ProfileInput>;

export interface Profile {
  name: string;
  harness: HarnessName;
  model: string;
  agent: string | null;
  instructions: string | null;
  permissionPolicy: PermissionPolicy;
  envAllowlist: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Tasks

export const DispatchTaskInput = z.object({
  repo: Slug,
  profile: Slug.optional(),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
  /** Duplicate requests with the same key return the original task. */
  idempotencyKey: z.string().min(8).max(128),
  dependsOn: z.array(z.string().min(1)).max(20).default([]),
});
export type DispatchTaskInput = z.input<typeof DispatchTaskInput>;

export const TaskFilter = z.object({
  state: z.array(TaskStateSchema).optional(),
  repo: Slug.optional(),
  open: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type TaskFilter = z.input<typeof TaskFilter>;

export const WorkerReport = z.object({
  summary: z.string().max(8000),
  changedFiles: z.array(z.string()).max(500).default([]),
  tests: z
    .array(
      z.object({
        command: z.string().max(500),
        outcome: z.enum(["passed", "failed", "not_run"]),
        details: z.string().max(2000).optional(),
      }),
    )
    .max(50)
    .default([]),
  unresolved: z.array(z.string().max(2000)).max(50).default([]),
});
export type WorkerReport = z.infer<typeof WorkerReport>;

/** Facts the supervisor established itself, independent of the worker's claims. */
export interface Verification {
  changedFiles: string[];
  dirty: boolean;
  commitsAhead: number;
  command: {
    argv: string[];
    exitCode: number | null;
    timedOut: boolean;
    outputTail: string;
  } | null;
}

export interface TaskResult {
  reported: WorkerReport | null;
  reportError: string | null;
  verification: Verification | null;
  finalMessageExcerpt: string | null;
}

export interface Task {
  id: string;
  idempotencyKey: string;
  repo: string;
  profile: Profile;
  harness: HarnessName;
  model: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  state: z.infer<typeof TaskStateSchema>;
  workspacePath: string | null;
  branch: string | null;
  baseRef: string | null;
  sessionId: string | null;
  attempts: number;
  result: TaskResult | null;
  error: string | null;
  dependsOn: string[];
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: string;
  data: unknown;
  createdAt: string;
}

export interface WorkerRun {
  id: string;
  taskId: string;
  attempt: number;
  harness: HarnessName;
  harnessVersion: string | null;
  sessionId: string | null;
  state: "launching" | "acknowledged" | "prompted" | "ended" | "lost";
  supervisorInstance: string;
  startedAt: string;
  endedAt: string | null;
  exitReason: string | null;
}

export interface TaskDetail {
  task: Task;
  runs: WorkerRun[];
  events: TaskEvent[];
  attention: Attention[];
}

export const SendToWorkerInput = z.object({ instructions: z.string().min(1).max(20_000) });
export const CancelTaskInput = z.object({ reason: z.string().max(1000).optional() });
export const ResumeTaskInput = z.object({
  /** reattach: continue the recorded session; relaunch: new session in the same workspace. */
  mode: z.enum(["reattach", "relaunch"]),
});

// ---------------------------------------------------------------------------
// Attention

export const AttentionKind = z.enum([
  "decision",
  "permission",
  "question",
  "failure",
  "stall",
  "review",
  "ambiguous_launch",
]);
export type AttentionKind = z.infer<typeof AttentionKind>;

export const AttentionStatus = z.enum(["open", "resolved", "expired", "rejected"]);
export type AttentionStatus = z.infer<typeof AttentionStatus>;

export interface Attention {
  id: string;
  taskId: string | null;
  repo: string | null;
  kind: AttentionKind;
  status: AttentionStatus;
  reason: string;
  /** The exact pending operation, e.g. the permission being requested. */
  operation: unknown;
  harness: HarnessName | null;
  sessionId: string | null;
  requestRef: string | null;
  resolvableBy: Actor;
  expiresAt: string | null;
  response: AttentionResponse | null;
  resolvedBy: Actor | null;
  createdAt: string;
  resolvedAt: string | null;
}

export const AttentionResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("deny"), message: z.string().max(2000).optional() }),
  z.object({ type: z.literal("answer"), text: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("acknowledge"), note: z.string().max(2000).optional() }),
]);
export type AttentionResponse = z.infer<typeof AttentionResponse>;

export const ResolveAttentionInput = z.object({ response: AttentionResponse });

export const AttentionFilter = z.object({
  status: AttentionStatus.optional(),
  taskId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Memory and decisions

export const MemoryScope = z.enum(["global", "repo", "task"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemorySource = z.enum(["human", "manager", "worker"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const RememberInput = z
  .object({
    scope: MemoryScope,
    repo: Slug.optional(),
    taskId: z.string().optional(),
    content: z.string().min(1).max(4000),
    /** human: an explicit human statement; manager/worker: an inferred lesson (proposal). */
    source: MemorySource,
    supersedes: z.string().optional(),
  })
  .refine((m) => m.scope !== "repo" || m.repo !== undefined, "Repository scope requires repo")
  .refine((m) => m.scope !== "task" || m.taskId !== undefined, "Task scope requires taskId");
export type RememberInput = z.input<typeof RememberInput>;

export interface Memory {
  id: string;
  scope: MemoryScope;
  repo: string | null;
  taskId: string | null;
  content: string;
  source: MemorySource;
  status: "proposed" | "confirmed" | "retired";
  recordedBy: Actor;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const RecallInput = z.object({
  query: z.string().min(1).max(500),
  /** Without repo/task, only global memory is searched. Global is never added implicitly to repo queries unless includeGlobal. */
  repo: Slug.optional(),
  taskId: z.string().optional(),
  includeGlobal: z.boolean().default(true),
  includeProposed: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(8),
});
export type RecallInput = z.input<typeof RecallInput>;

export interface RecallHit {
  memory: Memory;
  snippet: string;
}

export const DecisionInput = z.object({
  summary: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional(),
  repo: Slug.optional(),
  taskId: z.string().optional(),
});
export type DecisionInput = z.input<typeof DecisionInput>;

export interface Decision {
  id: string;
  taskId: string | null;
  repo: string | null;
  summary: string;
  rationale: string | null;
  decidedBy: Actor;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Manager, briefing, status

export const RegisterManagerInput = z.object({
  sessionId: z.string().min(1).max(200),
  directory: z.string().min(1),
  /** Replacing an existing manager must be explicit. */
  replace: z.boolean().default(false),
});
export type RegisterManagerInput = z.input<typeof RegisterManagerInput>;

export interface Manager {
  id: string;
  sessionId: string;
  directory: string;
  registeredBy: Actor;
  registeredAt: string;
}

export interface TaskSummary {
  id: string;
  repo: string;
  title: string;
  state: Task["state"];
  harness: HarnessName;
  updatedAt: string;
}

export interface Briefing {
  generatedAt: string;
  activeTasks: TaskSummary[];
  pendingAttention: Pick<
    Attention,
    "id" | "kind" | "taskId" | "repo" | "reason" | "resolvableBy"
  >[];
  preferences: Pick<Memory, "id" | "scope" | "repo" | "content">[];
  recentDecisions: Pick<Decision, "id" | "summary" | "repo" | "taskId" | "createdAt">[];
  truncated: boolean;
  text: string;
}

export interface AdapterStatus {
  harness: HarnessName;
  available: boolean;
  version: string | null;
  problems: string[];
}

export interface SupervisorStatus {
  apiVersion: number;
  pid: number;
  instanceId: string;
  startedAt: string;
  paused: boolean;
  concurrency: number;
  counts: Partial<Record<Task["state"], number>>;
  openAttention: number;
  outbox: { pending: number; failed: number; dead: number };
  manager: Manager | null;
  adapters: AdapterStatus[];
}

export interface OutboxEntry {
  id: string;
  kind: "notify" | "manager_wake";
  dedupeKey: string;
  payload: unknown;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ShutdownReport {
  workerPolicy: string;
  workers: { taskId: string; harness: HarnessName; sessionId: string | null; outcome: string }[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
