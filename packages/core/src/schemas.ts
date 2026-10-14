import { z } from "zod";

import { TASK_STATES } from "./states.ts";
import type { HarnessUsage, UsageStatus } from "./usage.ts";

// Wire contracts shared by the supervisor API, the CLI, and the plugin. Inputs
// are validated at every boundary; outputs are typed for clients.

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "Use lowercase letters, digits, '.', '_' or '-' (max 63)");

export const HarnessName = z.enum(["opencode", "claude", "codex", "fake"]);
export type HarnessName = z.infer<typeof HarnessName>;

export const PermissionPolicy = z.enum(["deny", "ask", "allow", "yolo"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const Actor = z.enum(["human", "manager"]);
export type Actor = z.infer<typeof Actor>;

export const TaskStateSchema = z.enum(TASK_STATES);

const EnvVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Environment variable names only");

/** off: nothing runs. detect: read-only drift/conflict status. refresh: detect, and update eligible idle task branches. */
export const BranchSyncMode = z.enum(["off", "detect", "refresh"]);
export type BranchSyncMode = z.infer<typeof BranchSyncMode>;

// ---------------------------------------------------------------------------
// Repositories and profiles (both declared in ocd.jsonc)

/** One entry under `repos` in ocd.jsonc; the key is the repository name. */
export const RepoConfig = z
  .object({
    path: z.string().min(1).describe("Repository root. `~` is expanded; symlinks are resolved."),
    profile: Slug.optional().describe(
      "Default profile for tasks in this repository; must be declared under profiles.",
    ),
    baseRef: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Ref new task branches start from. Defaults to the repository's current HEAD."),
    mergeMethod: z
      .enum(["squash", "merge", "rebase"])
      .optional()
      .describe(
        "How this repository's work lands (pull request merges and direct pushes); defaults to the top-level mergeMethod.",
      ),
    branchSync: BranchSyncMode.optional().describe(
      "Branch-sync mode for this repository's tasks, overriding branchSync.mode. Tracks baseRef, which must be set. See docs/branch-sync.md.",
    ),
  })
  .strict();
export type RepoConfig = z.input<typeof RepoConfig>;

export const ReposConfig = z.record(Slug, RepoConfig);

export interface Repository {
  id: string;
  name: string;
  path: string;
  defaultProfile: string | null;
  baseRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One entry under `profiles` in ocd.jsonc; the key is the profile name. */
export const ProfileConfig = z
  .object({
    harness: HarnessName.describe(
      "Harness that runs the worker: opencode (sessions in the OpenCode service), claude (Claude Code CLI), codex (codex app-server), or fake (tests).",
    ),
    model: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Model id. For OpenCode: provider/model, optionally #variant (see `opencode models`).",
      ),
    description: z
      .string()
      .max(500)
      .optional()
      .describe("When to use this profile. Shown to the manager, which picks profiles by name."),
    agent: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Harness agent preset, e.g. OpenCode's build agent."),
    instructions: z
      .string()
      .max(8000)
      .optional()
      .describe("Standing guidance added to every worker prompt using this profile."),
    permissionPolicy: PermissionPolicy.default("deny").describe(
      "ask: permission requests go to the human. deny: they are rejected and recorded. allow: each request is approved once, automatically, and recorded. yolo: the harness skips its permission checks and sandbox entirely (Claude Code --dangerously-skip-permissions, Codex approvalPolicy never + danger-full-access, OpenCode allow-all rule); nothing is asked or recorded.",
    ),
    envAllowlist: z
      .array(EnvVarName)
      .max(50)
      .default([])
      .describe(
        "Environment variables passed to the worker in addition to a minimal base set (PATH, HOME, ...).",
      ),
  })
  .strict()
  .refine((p) => p.harness !== "opencode" || /^[^/\s]+\/\S+$/.test(p.model), {
    message: "OpenCode models are written provider/model",
    path: ["model"],
  });
export type ProfileConfig = z.input<typeof ProfileConfig>;

export const ProfilesConfig = z.record(Slug, ProfileConfig);

export interface Profile {
  name: string;
  harness: HarnessName;
  model: string;
  description: string | null;
  agent: string | null;
  instructions: string | null;
  permissionPolicy: PermissionPolicy;
  envAllowlist: string[];
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
}

export interface TaskResult {
  reported: WorkerReport | null;
  reportError: string | null;
  verification: Verification | null;
  finalMessageExcerpt: string | null;
}

/**
 * What the branch-sync watchdog last established about a task branch relative
 * to its repository's configured base ref (docs/branch-sync.md).
 */
export interface BranchSync {
  /**
   * current: the branch contains the base tip. behind: the base advanced and the
   * refresh is pending (reason says until when). conflict: merging the base would
   * conflict; nothing was changed. skipped: not safe to evaluate or touch (reason
   * says why). error: a git command failed.
   */
  state: "current" | "behind" | "conflict" | "skipped" | "error";
  reason: string;
  /** The configured base ref name, e.g. main. */
  baseRef: string | null;
  baseTip: string | null;
  /** The task branch commit that was checked. */
  head: string | null;
  /** Commits on the base that the branch lacks. */
  behind: number | null;
  /** Files that would conflict (bounded), when state is conflict. */
  conflictFiles: string[];
  checkedAt: string;
  /** "<head>:<baseTip>" of the conflict last reported, so it is reported once. */
  conflictReported: string | null;
  /** A write OCD started but did not record finishing (crash recovery). */
  intent: { from: string; to: string; baseTip: string; method: "fast-forward" | "merge" } | null;
  lastRefresh: {
    at: string;
    from: string;
    to: string;
    baseTip: string;
    method: "fast-forward" | "merge";
    trigger: string;
  } | null;
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
  pullRequestUrl: string | null;
  /** Null until the branch-sync watchdog has looked at the task. */
  branchSync: BranchSync | null;
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

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One checklist item exactly as the worker's harness reported it (redacted, clipped). */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/** Most checklist items OCD keeps per task, and characters per item. */
export const TODO_LIMITS = { items: 50, chars: 200 } as const;

/**
 * A running task's factual progress, for the sidebar: the latest checklist the
 * harness reported and recent lifecycle events. Never transcripts or reasoning.
 */
export interface TaskProgress {
  taskId: string;
  /** Whether the task's harness reports checklists to OCD at all. */
  todosSupported: boolean;
  /** Latest checklist since the supervisor started; null when none was reported. */
  todos: TodoItem[] | null;
  todosUpdatedAt: string | null;
  /** The most recent task events, oldest first (bounded). */
  events: TaskEvent[];
}

export const SendToWorkerInput = z.object({ instructions: z.string().min(1).max(20_000) });
export const CancelTaskInput = z.object({ reason: z.string().max(1000).optional() });
export const CleanupTaskInput = z.object({ force: z.boolean().default(false) });
export const MergePullRequestInput = z.object({
  method: z.enum(["squash", "merge", "rebase"]).optional(),
});
export const DiscardTaskInput = z.object({ reason: z.string().max(1000).optional() });
export const OpenPullRequestInput = z.object({
  draft: z.boolean().default(false),
  base: z.string().min(1).max(200).optional(),
  /** Commit uncommitted worker changes before pushing. */
  commit: z.boolean().default(false),
});
export const MergeMethod = z.enum(["squash", "merge", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

export const LandTaskInput = z.object({
  /** Push straight to the base branch instead of going through a pull request. */
  direct: z.boolean().default(false),
  /** Pull request route only: commit uncommitted worker changes before pushing. */
  commit: z.boolean().default(false),
  /** Direct route, human: the plan's head commit, proving the push was confirmed. */
  confirm: z.string().min(7).max(64).optional(),
});
export type LandTaskInput = z.input<typeof LandTaskInput>;

/** What a direct landing would push; shown for confirmation before anything happens. */
export interface LandPlan {
  taskId: string;
  title: string;
  repo: string;
  remote: string;
  /** Branch on the remote that receives the work, e.g. main. */
  base: string;
  method: MergeMethod;
  /** The task branch's head commit; a confirmation is bound to it. */
  head: string;
  /** Commits on the task branch that the base does not have, oldest first. */
  commits: { sha: string; subject: string }[];
  files: string[];
  /** Uncommitted changes in the worktree; a direct landing refuses them. */
  dirty: boolean;
  pullRequestUrl: string | null;
  /** Why a direct landing would be refused right now; null when it can go ahead. */
  blocker: { code: string; message: string } | null;
}

export interface LandResult {
  task: Task;
  /** The work is in the base branch and the worktree is gone. */
  landed: boolean;
  /** What this call did, in order. */
  steps: string[];
  /** Why it stopped short, e.g. pr_checks_pending or confirmation_requested. */
  waiting: { code: string; message: string } | null;
  /** The confirmation request raised for the human (manager, direct route). */
  attentionId: string | null;
  /** The commit pushed to the base branch (direct route). */
  commit: string | null;
}

/** One file in a task's diff. */
export interface TaskDiffFile {
  path: string;
  status: "added" | "deleted" | "modified";
  /** null for binary files. */
  additions: number | null;
  deletions: number | null;
  /** Not committed yet (a change in the worktree, or a new untracked file). */
  uncommitted: boolean;
}

/** A task's changes against the point its branch left its base, uncommitted ones included. */
export interface TaskDiff {
  taskId: string;
  branch: string | null;
  /** The ref the task branch started from, e.g. main. */
  baseRef: string;
  mergeBase: string;
  head: string;
  files: TaskDiffFile[];
  /** Unified diff text (git format), capped in size. */
  patch: string;
  truncated: boolean;
}

export const RequestChangesInput = z.object({ feedback: z.string().min(1).max(20_000) });

export const GiveBackInput = z.object({
  /** continue: the worker resumes headless; review: the human is done, the task goes to review. */
  mode: z.enum(["continue", "review"]),
  note: z.string().max(4000).optional(),
});
export type GiveBackInput = z.input<typeof GiveBackInput>;

/** What the human runs to drive a taken-over session. */
export interface TakeOverResult {
  task: Task;
  /** Run in `cwd`, the task's worktree, with `env` set. */
  command: string[];
  cwd: string;
  /** The worker sandbox environment: the session stays isolated from the live OCD. */
  env: Record<string, string>;
  /** tmux.enabled in ocd.jsonc: the TUI may open the session in a tmux window. */
  tmux: boolean;
}

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
  "land",
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

/** The session currently acting as manager: the latest one used from the manager directory. */
export interface Manager {
  sessionId: string;
  directory: string;
  activatedAt: string;
}

export interface ManagerInfo {
  /** `manager.directory` from ocd.jsonc, or null when no manager is configured. */
  directory: string | null;
  active: Manager | null;
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
  /** Subscription usage limits the harnesses last reported, when any were. */
  usage?: HarnessUsage[];
  text: string;
}

export interface AdapterStatus {
  harness: HarnessName;
  available: boolean;
  version: string | null;
  problems: string[];
}

/**
 * Why the GitHub CLI cannot be used: not_found (not on PATH),
 * auth_missing / auth_invalid (log in again),
 * unreachable (network or timeout; the login may be fine), failed (other).
 */
export type GitHubCliProblem =
  | "not_found"
  | "auth_missing"
  | "auth_invalid"
  | "unreachable"
  | "failed";

/** The supervisor's own read-only check of the gh CLI that pull requests use. */
export interface GitHubCliStatus {
  /** gh was found and `gh --version` ran. */
  available: boolean;
  /** Where gh was found on the supervisor's PATH. */
  path: string | null;
  version: string | null;
  /** unknown when the check could not tell (e.g. GitHub unreachable), never a guess. */
  auth: "ok" | "missing" | "invalid" | "unknown";
  problem: GitHubCliProblem | null;
  /** Actionable, secret-free descriptions. */
  problems: string[];
  checkedAt: string;
}

/** OCD updating itself from its own repository (selfUpdate in ocd.jsonc). */
export interface UpdateStatus {
  enabled: boolean;
  /** The build the supervisor runs from (~/.ocd/install/current), if any. */
  current: string | null;
  previous: string | null;
  /** A built and smoke-tested version waiting to be switched to. */
  pending: { sha: string; subjects: string[]; builtAt: string } | null;
  /** Claude Code / Codex workers that a restart would interrupt; the update waits for them. */
  blockedBy: { taskId: string; title: string; harness: string }[];
  building: string | null;
  lastError: { sha: string; message: string; at: string } | null;
  /** Why an update cannot be switched to automatically, if it cannot. */
  cannotApply: string | null;
  checkedAt: string | null;
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
  /** null while the startup check runs, or when pull requests are not configured. */
  github?: GitHubCliStatus | null;
  /** Pull requests are on (github.enabled): tasks can land through a PR. */
  pullRequests?: boolean;
  update?: UpdateStatus | null;
  /** Subscription usage limits the harnesses reported (Claude Code, Codex). */
  usage?: UsageStatus | null;
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
