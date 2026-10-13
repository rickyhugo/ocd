import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
  Actor,
  AttentionKind,
  AttentionResponse,
  AttentionStatus,
  HarnessName,
  MemoryScope,
  MemorySource,
  PermissionPolicy,
  Profile,
  TaskResult,
  TaskState,
  WorkerRun,
} from "@ocd/core";

// Timestamps are ISO-8601 UTC strings. JSON columns hold validated values only.

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const repositories = sqliteTable("repositories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  path: text("path").notNull().unique(),
  defaultProfile: text("default_profile"),
  baseRef: text("base_ref"),
  verifyCommand: text("verify_command", { mode: "json" }).$type<string[]>(),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const profiles = sqliteTable("profiles", {
  name: text("name").primaryKey(),
  harness: text("harness").$type<HarnessName>().notNull(),
  model: text("model").notNull(),
  agent: text("agent"),
  instructions: text("instructions"),
  permissionPolicy: text("permission_policy").$type<PermissionPolicy>().notNull(),
  envAllowlist: text("env_allowlist", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id),
    profileSnapshot: text("profile_snapshot", { mode: "json" }).$type<Profile>().notNull(),
    harness: text("harness").$type<HarnessName>().notNull(),
    model: text("model").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    acceptanceCriteria: text("acceptance_criteria", { mode: "json" }).$type<string[]>().notNull(),
    state: text("state").$type<TaskState>().notNull(),
    workspacePath: text("workspace_path"),
    branch: text("branch"),
    baseRef: text("base_ref"),
    sessionId: text("session_id"),
    attempts: integer("attempts").notNull().default(0),
    result: text("result", { mode: "json" }).$type<TaskResult>(),
    error: text("error"),
    lastActivityAt: text("last_activity_at"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("tasks_state_idx").on(t.state), index("tasks_repo_idx").on(t.repoId)],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOn: text("depends_on")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOn] })],
);

export const workerRuns = sqliteTable(
  "worker_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    attempt: integer("attempt").notNull(),
    harness: text("harness").$type<HarnessName>().notNull(),
    harnessVersion: text("harness_version"),
    sessionId: text("session_id"),
    state: text("state").$type<WorkerRun["state"]>().notNull(),
    supervisorInstance: text("supervisor_instance").notNull(),
    startedAt: text("started_at").notNull().default(now),
    endedAt: text("ended_at"),
    exitReason: text("exit_reason"),
  },
  (t) => [uniqueIndex("worker_runs_task_attempt_idx").on(t.taskId, t.attempt)],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type").notNull(),
    data: text("data", { mode: "json" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").references(() => tasks.id),
  repoId: text("repo_id").references(() => repositories.id),
  summary: text("summary").notNull(),
  rationale: text("rationale"),
  decidedBy: text("decided_by").$type<Actor>().notNull(),
  createdAt: text("created_at").notNull().default(now),
});

export const memories = sqliteTable(
  "memories",
  {
    // Integer rowid backs the FTS5 external-content index (see custom migration).
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    scope: text("scope").$type<MemoryScope>().notNull(),
    repoId: text("repo_id").references(() => repositories.id),
    taskId: text("task_id").references(() => tasks.id),
    content: text("content").notNull(),
    source: text("source").$type<MemorySource>().notNull(),
    status: text("status").$type<"proposed" | "confirmed" | "retired">().notNull(),
    recordedBy: text("recorded_by").$type<Actor>().notNull(),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("memories_scope_idx").on(t.scope, t.repoId, t.status)],
);

export const attentionRequests = sqliteTable(
  "attention_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => tasks.id),
    kind: text("kind").$type<AttentionKind>().notNull(),
    status: text("status").$type<AttentionStatus>().notNull(),
    /** Stable key so duplicate harness events do not create duplicate requests. */
    dedupeKey: text("dedupe_key").notNull().unique(),
    reason: text("reason").notNull(),
    operation: text("operation", { mode: "json" }),
    harness: text("harness").$type<HarnessName>(),
    sessionId: text("session_id"),
    runId: text("run_id"),
    requestRef: text("request_ref"),
    resolvableBy: text("resolvable_by").$type<Actor>().notNull(),
    expiresAt: text("expires_at"),
    response: text("response", { mode: "json" }).$type<AttentionResponse>(),
    resolvedBy: text("resolved_by").$type<Actor>(),
    createdAt: text("created_at").notNull().default(now),
    resolvedAt: text("resolved_at"),
  },
  (t) => [index("attention_status_idx").on(t.status)],
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"notify" | "manager_wake">().notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").$type<"pending" | "delivered" | "dead">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull().default(now),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(now),
    deliveredAt: text("delivered_at"),
  },
  (t) => [index("outbox_due_idx").on(t.status, t.nextAttemptAt)],
);

export const managers = sqliteTable("managers", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  directory: text("directory").notNull(),
  registeredBy: text("registered_by").$type<Actor>().notNull(),
  active: integer("active", { mode: "boolean" }).notNull(),
  registeredAt: text("registered_at").notNull().default(now),
  retiredAt: text("retired_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});
