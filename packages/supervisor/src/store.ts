import {
  assertTransition,
  type Actor,
  type Attention,
  type AttentionKind,
  type AttentionStatus,
  type Decision,
  type HarnessName,
  type Manager,
  type Memory,
  type OutboxEntry,
  type Profile,
  type Repository,
  type Task,
  type TaskEvent,
  type TaskState,
  type WorkerRun,
} from "@ocd/core";
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "./db/index.ts";
import {
  attentionRequests,
  decisions,
  managers,
  memories,
  outbox,
  profiles,
  repositories,
  settings,
  taskDependencies,
  taskEvents,
  tasks,
  workerRuns,
} from "./db/schema.ts";
import { ApiError, conflict, notFound } from "./errors.ts";
import { iso, newId, type Clock } from "./ids.ts";

type TaskRow = typeof tasks.$inferSelect;
type RepoRow = typeof repositories.$inferSelect;
type RunRow = typeof workerRuns.$inferSelect;
type AttentionRow = typeof attentionRequests.$inferSelect;
type MemoryRow = typeof memories.$inferSelect;

export interface OutboxInput {
  kind: "notify" | "manager_wake";
  dedupeKey: string;
  payload: NotifyPayload | WakePayload;
}

export interface NotifyPayload {
  title: string;
  body: string;
}

export interface WakePayload {
  text: string;
  taskId?: string;
}

export interface AttentionInput {
  taskId: string | null;
  kind: AttentionKind;
  dedupeKey: string;
  reason: string;
  operation?: unknown;
  harness?: HarnessName | null;
  sessionId?: string | null;
  runId?: string | null;
  requestRef?: string | null;
  resolvableBy: Actor;
  expiresAt?: string | null;
  status?: AttentionStatus;
}

export interface TransitionOptions {
  /** Compare-and-set: the transition only applies from one of these states. */
  from?: readonly TaskState[];
  patch?: Partial<Omit<TaskRow, "id" | "state">>;
  event?: { type: string; data?: unknown };
  outbox?: OutboxInput[];
  attention?: { input: AttentionInput; notify: boolean; wake: boolean }[];
}

export class Store {
  readonly db: Db;
  private readonly clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  now(): string {
    return iso(this.clock());
  }

  /** Runs fn atomically. Nested calls become savepoints. */
  tx<T>(fn: () => T): T {
    return this.db.$client.transaction(fn)();
  }

  // -------------------------------------------------------------------------
  // Repositories and profiles

  addRepo(input: {
    name: string;
    path: string;
    defaultProfile?: string | undefined;
    baseRef?: string | undefined;
    verifyCommand?: string[] | undefined;
  }): Repository {
    if (input.defaultProfile && !this.getProfile(input.defaultProfile)) {
      throw notFound(`Profile ${input.defaultProfile}`);
    }
    const existing = this.db
      .select()
      .from(repositories)
      .where(eq(repositories.name, input.name))
      .get();
    const values = {
      path: input.path,
      defaultProfile: input.defaultProfile ?? null,
      baseRef: input.baseRef ?? null,
      verifyCommand: input.verifyCommand ?? null,
      updatedAt: this.now(),
    };
    try {
      if (existing) {
        this.db.update(repositories).set(values).where(eq(repositories.id, existing.id)).run();
      } else {
        this.db
          .insert(repositories)
          .values({ id: newId("r"), name: input.name, createdAt: this.now(), ...values })
          .run();
      }
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw conflict("repo_path_taken", `${input.path} is already registered`);
      throw error;
    }
    return this.requireRepo(input.name);
  }

  listRepos(): Repository[] {
    return this.db.select().from(repositories).orderBy(asc(repositories.name)).all().map(toRepo);
  }

  getRepo(name: string): Repository | null {
    const row = this.db.select().from(repositories).where(eq(repositories.name, name)).get();
    return row ? toRepo(row) : null;
  }

  requireRepo(name: string): Repository {
    const repo = this.getRepo(name);
    if (!repo) throw notFound(`Repository ${name}`);
    return repo;
  }

  removeRepo(name: string): boolean {
    const repo = this.requireRepo(name);
    const used = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.repoId, repo.id))
      .limit(1)
      .get();
    if (used)
      throw conflict(
        "repo_has_history",
        `Repository ${name} has task history and cannot be removed`,
      );
    this.db.delete(repositories).where(eq(repositories.id, repo.id)).run();
    return true;
  }

  upsertProfile(profile: Omit<Profile, "createdAt" | "updatedAt">): Profile {
    const now = this.now();
    this.db
      .insert(profiles)
      .values({ ...profile, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: profiles.name, set: { ...profile, updatedAt: now } })
      .run();
    return this.requireProfile(profile.name);
  }

  listProfiles(): Profile[] {
    return this.db.select().from(profiles).orderBy(asc(profiles.name)).all();
  }

  getProfile(name: string): Profile | null {
    return this.db.select().from(profiles).where(eq(profiles.name, name)).get() ?? null;
  }

  requireProfile(name: string): Profile {
    const profile = this.getProfile(name);
    if (!profile) throw notFound(`Profile ${name}`);
    return profile;
  }

  // -------------------------------------------------------------------------
  // Tasks

  createTask(input: {
    idempotencyKey: string;
    repo: Repository;
    profile: Profile;
    title: string;
    instructions: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
  }): { task: Task; created: boolean } {
    return this.tx(() => {
      const existing = this.db
        .select()
        .from(tasks)
        .where(eq(tasks.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing) {
        if (existing.instructions !== input.instructions || existing.repoId !== input.repo.id) {
          throw conflict(
            "idempotency_mismatch",
            "Idempotency key was already used for a different task",
            {
              taskId: existing.id,
            },
          );
        }
        return { task: this.requireTask(existing.id), created: false };
      }
      for (const dep of input.dependsOn) {
        if (!this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, dep)).get()) {
          throw notFound(`Dependency task ${dep}`);
        }
      }
      const id = newId("t");
      const now = this.now();
      this.db
        .insert(tasks)
        .values({
          id,
          idempotencyKey: input.idempotencyKey,
          repoId: input.repo.id,
          profileSnapshot: input.profile,
          harness: input.profile.harness,
          model: input.profile.model,
          title: input.title,
          instructions: input.instructions,
          acceptanceCriteria: input.acceptanceCriteria,
          state: "queued",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      for (const dep of input.dependsOn)
        this.db.insert(taskDependencies).values({ taskId: id, dependsOn: dep }).run();
      this.appendEvent(id, "task.created", { repo: input.repo.name, profile: input.profile.name });
      return { task: this.requireTask(id), created: true };
    });
  }

  taskRow(id: string): TaskRow | null {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get() ?? null;
  }

  getTask(id: string): Task | null {
    const row = this.taskRow(id);
    return row ? this.toTask(row) : null;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw notFound(`Task ${id}`);
    return task;
  }

  listTasks(filter: { state?: TaskState[]; repo?: string; limit?: number } = {}): Task[] {
    const where: SQL[] = [];
    if (filter.state?.length) where.push(inArray(tasks.state, filter.state));
    if (filter.repo) {
      const repo = this.getRepo(filter.repo);
      if (!repo) return [];
      where.push(eq(tasks.repoId, repo.id));
    }
    return this.db
      .select()
      .from(tasks)
      .where(and(...where))
      .orderBy(desc(tasks.createdAt))
      .limit(filter.limit ?? 50)
      .all()
      .map((row) => this.toTask(row));
  }

  /** Oldest first, for admission. */
  queuedTasks(): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(eq(tasks.state, "queued"))
      .orderBy(asc(tasks.createdAt))
      .all();
  }

  rowsInStates(states: readonly TaskState[]): TaskRow[] {
    return this.db
      .select()
      .from(tasks)
      .where(inArray(tasks.state, [...states]))
      .orderBy(asc(tasks.createdAt))
      .all();
  }

  taskBySession(sessionId: string): TaskRow | null {
    return this.db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).get() ?? null;
  }

  dependencies(taskId: string): TaskRow[] {
    return this.db
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOn))
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.task);
  }

  countByState(): Partial<Record<TaskState, number>> {
    const rows = this.db
      .select({ state: tasks.state, n: sql<number>`count(*)` })
      .from(tasks)
      .groupBy(tasks.state)
      .all();
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }

  /**
   * Applies a state transition with its event, attention requests, and outbox
   * entries in one transaction, so a crash never separates them.
   */
  transition(taskId: string, to: TaskState, options: TransitionOptions = {}): Task {
    return this.tx(() => {
      const row = this.taskRow(taskId);
      if (!row) throw notFound(`Task ${taskId}`);
      if (options.from && !options.from.includes(row.state)) {
        throw conflict(
          "state_changed",
          `Task ${taskId} is ${row.state}, expected ${options.from.join("/")}`,
        );
      }
      if (row.state !== to) assertTransition(row.state, to);
      this.db
        .update(tasks)
        .set({ ...options.patch, state: to, updatedAt: this.now() })
        .where(eq(tasks.id, taskId))
        .run();
      this.appendEvent(taskId, options.event?.type ?? `state.${to}`, {
        from: row.state,
        to,
        ...(options.event?.data === undefined ? {} : { data: options.event.data }),
      });
      for (const a of options.attention ?? []) this.raiseAttention(a.input, a);
      this.enqueue(options.outbox ?? []);
      return this.requireTask(taskId);
    });
  }

  patchTask(
    taskId: string,
    patch: Partial<Omit<TaskRow, "id" | "state">>,
    event?: { type: string; data?: unknown },
  ): void {
    this.tx(() => {
      this.db
        .update(tasks)
        .set({ ...patch, updatedAt: this.now() })
        .where(eq(tasks.id, taskId))
        .run();
      if (event) this.appendEvent(taskId, event.type, event.data);
    });
  }

  touchActivity(taskId: string, at: string): void {
    this.db.update(tasks).set({ lastActivityAt: at }).where(eq(tasks.id, taskId)).run();
  }

  appendEvent(taskId: string, type: string, data?: unknown): void {
    this.db
      .insert(taskEvents)
      .values({ taskId, type, data: data ?? null, createdAt: this.now() })
      .run();
  }

  events(taskId: string, limit = 100): TaskEvent[] {
    return this.db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(desc(taskEvents.id))
      .limit(limit)
      .all()
      .reverse()
      .map((e) => ({ ...e, data: e.data ?? null }));
  }

  // -------------------------------------------------------------------------
  // Worker runs

  createRun(input: {
    taskId: string;
    attempt: number;
    harness: HarnessName;
    supervisorInstance: string;
  }): WorkerRun {
    const id = newId("w");
    this.db
      .insert(workerRuns)
      .values({ id, ...input, state: "launching", startedAt: this.now() })
      .run();
    return this.requireRun(id);
  }

  updateRun(id: string, patch: Partial<Omit<RunRow, "id" | "taskId">>): void {
    this.db.update(workerRuns).set(patch).where(eq(workerRuns.id, id)).run();
  }

  requireRun(id: string): WorkerRun {
    const row = this.db.select().from(workerRuns).where(eq(workerRuns.id, id)).get();
    if (!row) throw notFound(`Worker run ${id}`);
    return row;
  }

  runs(taskId: string): WorkerRun[] {
    return this.db
      .select()
      .from(workerRuns)
      .where(eq(workerRuns.taskId, taskId))
      .orderBy(asc(workerRuns.attempt))
      .all();
  }

  latestRun(taskId: string): WorkerRun | null {
    return (
      this.db
        .select()
        .from(workerRuns)
        .where(eq(workerRuns.taskId, taskId))
        .orderBy(desc(workerRuns.attempt))
        .limit(1)
        .get() ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Attention

  /**
   * Inserts an attention request unless its dedupe key exists. Notification and
   * manager wake-up outbox entries are written in the same transaction.
   */
  raiseAttention(
    input: AttentionInput,
    delivery: { notify: boolean; wake: boolean },
  ): { attention: Attention; created: boolean } {
    return this.tx(() => {
      const existing = this.db
        .select()
        .from(attentionRequests)
        .where(eq(attentionRequests.dedupeKey, input.dedupeKey))
        .get();
      if (existing) return { attention: this.toAttention(existing), created: false };
      const id = newId("a");
      this.db
        .insert(attentionRequests)
        .values({
          id,
          taskId: input.taskId,
          kind: input.kind,
          status: input.status ?? "open",
          dedupeKey: input.dedupeKey,
          reason: input.reason,
          operation: input.operation ?? null,
          harness: input.harness ?? null,
          sessionId: input.sessionId ?? null,
          runId: input.runId ?? null,
          requestRef: input.requestRef ?? null,
          resolvableBy: input.resolvableBy,
          expiresAt: input.expiresAt ?? null,
          createdAt: this.now(),
        })
        .run();
      if (input.taskId)
        this.appendEvent(input.taskId, "attention.raised", { id, kind: input.kind });
      const attention = this.requireAttention(id);
      const label = attention.taskId ? `${attention.kind} · ${attention.taskId}` : attention.kind;
      const entries: OutboxInput[] = [];
      if (delivery.notify) {
        entries.push({
          kind: "notify",
          dedupeKey: `notify:${id}`,
          payload: { title: `OCD: ${label}`, body: attention.reason },
        });
      }
      if (delivery.wake) {
        entries.push({
          kind: "manager_wake",
          dedupeKey: `wake:${id}`,
          payload: {
            text: `[${label}] (attention ${id}) ${attention.reason}`,
            ...(attention.taskId ? { taskId: attention.taskId } : {}),
          },
        });
      }
      this.enqueue(entries);
      return { attention, created: true };
    });
  }

  getAttention(id: string): Attention | null {
    const row = this.db.select().from(attentionRequests).where(eq(attentionRequests.id, id)).get();
    return row ? this.toAttention(row) : null;
  }

  requireAttention(id: string): Attention {
    const attention = this.getAttention(id);
    if (!attention) throw notFound(`Attention request ${id}`);
    return attention;
  }

  listAttention(
    filter: {
      status?: AttentionStatus;
      taskId?: string;
      kinds?: AttentionKind[];
      limit?: number;
    } = {},
  ): Attention[] {
    const where: SQL[] = [];
    if (filter.status) where.push(eq(attentionRequests.status, filter.status));
    if (filter.taskId) where.push(eq(attentionRequests.taskId, filter.taskId));
    if (filter.kinds?.length) where.push(inArray(attentionRequests.kind, filter.kinds));
    return this.db
      .select()
      .from(attentionRequests)
      .where(and(...where))
      .orderBy(desc(attentionRequests.createdAt))
      .limit(filter.limit ?? 50)
      .all()
      .map((r) => this.toAttention(r));
  }

  settleAttention(
    id: string,
    patch: {
      status: AttentionStatus;
      response?: AttentionRow["response"];
      resolvedBy?: Actor | null;
    },
  ): Attention {
    this.db
      .update(attentionRequests)
      .set({
        status: patch.status,
        response: patch.response ?? null,
        resolvedBy: patch.resolvedBy ?? null,
        resolvedAt: this.now(),
      })
      .where(and(eq(attentionRequests.id, id), eq(attentionRequests.status, "open")))
      .run();
    return this.requireAttention(id);
  }

  countOpenAttention(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(attentionRequests)
      .where(eq(attentionRequests.status, "open"))
      .get();
    return row?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Outbox

  /** Duplicate dedupe keys are ignored, so replayed events cannot multiply alerts. */
  enqueue(entries: OutboxInput[]): void {
    for (const entry of entries) {
      this.db
        .insert(outbox)
        .values({
          id: newId("o"),
          kind: entry.kind,
          dedupeKey: entry.dedupeKey,
          payload: entry.payload,
          status: "pending",
          nextAttemptAt: this.now(),
          createdAt: this.now(),
        })
        .onConflictDoNothing({ target: outbox.dedupeKey })
        .run();
    }
  }

  dueOutbox(kind: OutboxEntry["kind"], limit = 20): OutboxEntry[] {
    return this.db
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.status, "pending"),
          eq(outbox.kind, kind),
          lte(outbox.nextAttemptAt, this.now()),
        ),
      )
      .orderBy(asc(outbox.createdAt))
      .limit(limit)
      .all();
  }

  markDelivered(ids: string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(outbox)
      .set({ status: "delivered", deliveredAt: this.now() })
      .where(inArray(outbox.id, ids))
      .run();
  }

  markDeliveryFailed(
    ids: string[],
    error: string,
    maxAttempts: number,
    baseDelayMs: number,
    countAttempt = true,
  ): void {
    this.tx(() => {
      for (const id of ids) {
        const row = this.db.select().from(outbox).where(eq(outbox.id, id)).get();
        if (!row) continue;
        const attempts = countAttempt ? row.attempts + 1 : row.attempts;
        const delay = Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), 3_600_000);
        this.db
          .update(outbox)
          .set({
            attempts,
            lastError: error,
            status: attempts >= maxAttempts ? "dead" : "pending",
            nextAttemptAt: iso(this.clock() + delay),
          })
          .where(eq(outbox.id, id))
          .run();
      }
    });
  }

  listOutbox(status?: OutboxEntry["status"], limit = 100): OutboxEntry[] {
    return this.db
      .select()
      .from(outbox)
      .where(status ? eq(outbox.status, status) : undefined)
      .orderBy(desc(outbox.createdAt))
      .limit(limit)
      .all();
  }

  outboxCounts(): { pending: number; failed: number; dead: number } {
    const rows = this.db
      .select({
        status: outbox.status,
        failed: sql<number>`sum(case when ${outbox.attempts} > 0 then 1 else 0 end)`,
        n: sql<number>`count(*)`,
      })
      .from(outbox)
      .where(inArray(outbox.status, ["pending", "dead"]))
      .groupBy(outbox.status)
      .all();
    const pending = rows.find((r) => r.status === "pending");
    return {
      pending: pending?.n ?? 0,
      failed: pending?.failed ?? 0,
      dead: rows.find((r) => r.status === "dead")?.n ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Memory and decisions

  insertMemory(
    input: Omit<Memory, "id" | "createdAt" | "updatedAt" | "supersededBy" | "repo"> & {
      repoId: string | null;
    },
  ): Memory {
    const id = newId("m");
    const now = this.now();
    this.db
      .insert(memories)
      .values({
        id,
        scope: input.scope,
        repoId: input.repoId,
        taskId: input.taskId,
        content: input.content,
        source: input.source,
        status: input.status,
        recordedBy: input.recordedBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.requireMemory(id);
  }

  memoryRow(id: string): MemoryRow | null {
    return this.db.select().from(memories).where(eq(memories.id, id)).get() ?? null;
  }

  requireMemory(id: string): Memory {
    const row = this.memoryRow(id);
    if (!row) throw notFound(`Memory ${id}`);
    return this.toMemory(row);
  }

  updateMemory(id: string, patch: Partial<Pick<MemoryRow, "status" | "supersededBy">>): Memory {
    this.db
      .update(memories)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(memories.id, id))
      .run();
    return this.requireMemory(id);
  }

  deleteMemory(id: string): boolean {
    return this.db.delete(memories).where(eq(memories.id, id)).run().changes > 0;
  }

  listMemories(
    filter: {
      status?: Memory["status"];
      scope?: Memory["scope"];
      repoId?: string | null;
      limit?: number;
    } = {},
  ): Memory[] {
    const where: SQL[] = [];
    if (filter.status) where.push(eq(memories.status, filter.status));
    if (filter.scope) where.push(eq(memories.scope, filter.scope));
    if (filter.repoId) where.push(eq(memories.repoId, filter.repoId));
    return this.db
      .select()
      .from(memories)
      .where(and(...where))
      .orderBy(desc(memories.createdAt))
      .limit(filter.limit ?? 100)
      .all()
      .map((r) => this.toMemory(r));
  }

  /** FTS5 search. `scopeSql` must restrict scope; it is built by the memory service. */
  searchMemories(
    match: string,
    scopeSql: SQL,
    statuses: Memory["status"][],
    limit: number,
  ): { row: MemoryRow; snippet: string }[] {
    const rows = this.db.all<MemoryRow & { snip: string }>(sql`
      SELECT m.*, snippet(memories_fts, 0, '[', ']', '…', 16) AS snip
      FROM memories_fts
      JOIN memories m ON m.seq = memories_fts.rowid
      WHERE memories_fts MATCH ${match}
        AND m.status IN (${sql.join(
          statuses.map((s) => sql`${s}`),
          sql`, `,
        )})
        AND (${scopeSql})
      ORDER BY bm25(memories_fts)
      LIMIT ${limit}
    `);
    return rows.map((r) => ({
      // Raw SQL returns column names, not Drizzle property names.
      row: this.memoryFromRaw(r as unknown as Record<string, unknown>),
      snippet: r.snip,
    }));
  }

  private memoryFromRaw(r: Record<string, unknown>): MemoryRow {
    return {
      seq: r["seq"] as number,
      id: r["id"] as string,
      scope: r["scope"] as MemoryRow["scope"],
      repoId: (r["repo_id"] as string | null) ?? null,
      taskId: (r["task_id"] as string | null) ?? null,
      content: r["content"] as string,
      source: r["source"] as MemoryRow["source"],
      status: r["status"] as MemoryRow["status"],
      recordedBy: r["recorded_by"] as Actor,
      supersededBy: (r["superseded_by"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  insertDecision(input: {
    summary: string;
    rationale: string | null;
    repoId: string | null;
    taskId: string | null;
    decidedBy: Actor;
  }): Decision {
    const id = newId("d");
    this.db
      .insert(decisions)
      .values({ id, ...input, createdAt: this.now() })
      .run();
    if (input.taskId) this.appendEvent(input.taskId, "decision.recorded", { id });
    return this.listDecisions({ id })[0]!;
  }

  listDecisions(
    filter: { id?: string; repoId?: string; taskId?: string; limit?: number } = {},
  ): Decision[] {
    const where: SQL[] = [];
    if (filter.id) where.push(eq(decisions.id, filter.id));
    if (filter.repoId) where.push(eq(decisions.repoId, filter.repoId));
    if (filter.taskId) where.push(eq(decisions.taskId, filter.taskId));
    return this.db
      .select({ decision: decisions, repo: repositories.name })
      .from(decisions)
      .leftJoin(repositories, eq(repositories.id, decisions.repoId))
      .where(and(...where))
      .orderBy(desc(decisions.createdAt))
      .limit(filter.limit ?? 50)
      .all()
      .map(({ decision, repo }) => ({
        id: decision.id,
        taskId: decision.taskId,
        repo,
        summary: decision.summary,
        rationale: decision.rationale,
        decidedBy: decision.decidedBy,
        createdAt: decision.createdAt,
      }));
  }

  // -------------------------------------------------------------------------
  // Manager and settings

  activeManager(): Manager | null {
    const row = this.db.select().from(managers).where(eq(managers.active, true)).get();
    return row
      ? {
          id: row.id,
          sessionId: row.sessionId,
          directory: row.directory,
          registeredBy: row.registeredBy,
          registeredAt: row.registeredAt,
        }
      : null;
  }

  registerManager(input: {
    sessionId: string;
    directory: string;
    registeredBy: Actor;
    replace: boolean;
  }): Manager {
    return this.tx(() => {
      const current = this.activeManager();
      if (current && current.sessionId === input.sessionId) return current;
      if (current && !input.replace) {
        throw conflict(
          "manager_exists",
          `Manager session ${current.sessionId} is already registered; replace it explicitly`,
        );
      }
      if (current) {
        this.db
          .update(managers)
          .set({ active: false, retiredAt: this.now() })
          .where(eq(managers.id, current.id))
          .run();
      }
      const id = newId("mgr");
      this.db
        .insert(managers)
        .values({
          id,
          sessionId: input.sessionId,
          directory: input.directory,
          registeredBy: input.registeredBy,
          active: true,
          registeredAt: this.now(),
        })
        .run();
      return this.activeManager()!;
    });
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (row.value as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: this.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: this.now() } })
      .run();
  }

  // -------------------------------------------------------------------------
  // Mapping

  repoNameById(id: string | null): string | null {
    if (!id) return null;
    return (
      this.db
        .select({ name: repositories.name })
        .from(repositories)
        .where(eq(repositories.id, id))
        .get()?.name ?? null
    );
  }

  toTask(row: TaskRow): Task {
    const dependsOn = this.db
      .select({ id: taskDependencies.dependsOn })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, row.id))
      .all()
      .map((d) => d.id);
    return {
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      repo: this.repoNameById(row.repoId) ?? row.repoId,
      profile: row.profileSnapshot,
      harness: row.harness,
      model: row.model,
      title: row.title,
      instructions: row.instructions,
      acceptanceCriteria: row.acceptanceCriteria,
      state: row.state,
      workspacePath: row.workspacePath,
      branch: row.branch,
      baseRef: row.baseRef,
      sessionId: row.sessionId,
      attempts: row.attempts,
      result: row.result ?? null,
      error: row.error,
      dependsOn,
      lastActivityAt: row.lastActivityAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  private toAttention(row: AttentionRow): Attention {
    const task = row.taskId ? this.taskRow(row.taskId) : null;
    return {
      id: row.id,
      taskId: row.taskId,
      repo: task ? this.repoNameById(task.repoId) : null,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      operation: row.operation ?? null,
      harness: row.harness,
      sessionId: row.sessionId,
      requestRef: row.requestRef,
      resolvableBy: row.resolvableBy,
      expiresAt: row.expiresAt,
      response: row.response ?? null,
      resolvedBy: row.resolvedBy,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }

  attentionRunId(id: string): string | null {
    return (
      this.db
        .select({ runId: attentionRequests.runId })
        .from(attentionRequests)
        .where(eq(attentionRequests.id, id))
        .get()?.runId ?? null
    );
  }

  toMemory(row: MemoryRow): Memory {
    return {
      id: row.id,
      scope: row.scope,
      repo: this.repoNameById(row.repoId),
      taskId: row.taskId,
      content: row.content,
      source: row.source,
      status: row.status,
      recordedBy: row.recordedBy,
      supersededBy: row.supersededBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function toRepo(row: RepoRow): Repository {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    defaultProfile: row.defaultProfile,
    baseRef: row.baseRef,
    verifyCommand: row.verifyCommand ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export { ApiError };
