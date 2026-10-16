import { z } from "zod";

import {
  AttentionFilter,
  CancelTaskInput,
  CleanupTaskInput,
  DecisionInput,
  DiscardTaskInput,
  DispatchTaskInput,
  GiveBackInput,
  LandTaskInput,
  MemoryScope,
  MemoryStatus,
  MergePullRequestInput,
  OpenPullRequestInput,
  OutboxStatus,
  RecallInput,
  RememberInput,
  RequestChangesInput,
  ResolveAttentionInput,
  ResumeTaskInput,
  SendToWorkerInput,
  TaskFilter,
  TaskStateSchema,
  type Attention,
  type Briefing,
  type Decision,
  type LandPlan,
  type LandResult,
  type ManagerInfo,
  type Memory,
  type OutboxEntry,
  type Profile,
  type RecallHit,
  type Repository,
  type ShutdownReport,
  type SupervisorStatus,
  type TakeOverResult,
  type Task,
  type TaskDetail,
  type TaskDiff,
  type TaskProgress,
  type UpdateStatus,
} from "./schemas.ts";
import type { TaskView } from "./lifecycle.ts";
import { PeekTaskInput, type TaskTranscript } from "./transcript.ts";
import type { UsageStatus } from "./usage.ts";

// The wire contract between the supervisor and its clients, defined once: the
// supervisor registers its handlers against these entries and parses with
// their schemas, OcdClient sends through them, and the manager tools build on
// the same input schemas. Adding a route means adding it here.

type Schema = z.ZodType | undefined;

export interface Route<
  Params extends Schema = Schema,
  Query extends Schema = Schema,
  Body extends Schema = Schema,
  Output = unknown,
> {
  method: "GET" | "POST" | "DELETE";
  /** Fastify-style: `:name` segments are filled from `params`. */
  path: string;
  params?: Params;
  /** Parsed from the query string, so the schema turns text into typed values. */
  query?: Query;
  body?: Body;
  /** Only the type is meaningful: responses are checked in tests, not on every call. */
  output: z.ZodType<Output>;
  /** Idle timeout; defaults to the client's. */
  timeoutMs?: number;
}

export type AnyRoute = Route<Schema, Schema, Schema, unknown>;

/** Idle timeout for calls that run git, gh or cleanup on the supervisor and can take minutes. */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;

/** An output known only by its TypeScript type. */
const type = <T>() => z.custom<T>();

function route<
  Params extends Schema = undefined,
  Query extends Schema = undefined,
  Body extends Schema = undefined,
  Output = unknown,
>(def: Route<Params, Query, Body, Output>): Route<Params, Query, Body, Output> {
  return def;
}

export const IdParams = z.object({ id: z.string().min(1).max(100) });

// Query strings carry text. These turn the parameters the supervisor accepts
// into typed values; anything unusable is dropped and the schema the value
// lands in decides whether what remains is valid.
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const nonEmpty = <T extends z.ZodType>(schema: T) => z.preprocess(text, schema);
const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => text(v)?.split(","), z.array(item).optional());
const flag = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "true" ? true : v === "false" ? false : undefined), schema);
const count = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (text(v) === undefined ? undefined : Number(v)), schema);

const TaskListQuery = z.object({
  state: csv(TaskStateSchema),
  repo: TaskFilter.shape.repo,
  open: flag(TaskFilter.shape.open),
  limit: count(TaskFilter.shape.limit),
});
const TranscriptQuery = z.object({
  limit: count(PeekTaskInput.shape.limit),
  before: nonEmpty(PeekTaskInput.shape.before),
  reasoningSummaries: flag(PeekTaskInput.shape.reasoningSummaries),
});
const AttentionListQuery = z.object({
  status: AttentionFilter.shape.status,
  taskId: AttentionFilter.shape.taskId,
  limit: count(AttentionFilter.shape.limit),
});
const MemoryListQuery = z.object({
  status: nonEmpty(MemoryStatus.optional()),
  scope: nonEmpty(MemoryScope.optional()),
  repo: nonEmpty(z.string().optional()),
});
const DecisionListQuery = z.object({
  repo: nonEmpty(z.string().optional()),
  taskId: nonEmpty(z.string().optional()),
});
const OutboxListQuery = z.object({
  status: nonEmpty(OutboxStatus.optional()),
});

export const UpdateApplyInput = z.object({ force: z.boolean().default(false) });
/** POST routes that take no input still send an empty object. */
const EmptyBody = z.object({});

const task = (suffix = "") => `/v1/tasks/:id${suffix}`;

export const routes = {
  status: route({ method: "GET", path: "/v1/status", output: type<SupervisorStatus>() }),
  pause: route({ method: "POST", path: "/v1/pause", output: type<{ paused: boolean }>() }),
  resume: route({ method: "POST", path: "/v1/resume", output: type<{ paused: boolean }>() }),
  shutdown: route({
    method: "POST",
    path: "/v1/shutdown",
    output: type<ShutdownReport>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),

  usage: route({ method: "GET", path: "/v1/usage", output: type<UsageStatus>() }),
  refreshUsage: route({
    method: "POST",
    path: "/v1/usage/refresh",
    body: EmptyBody,
    output: type<UsageStatus>(),
  }),
  updateStatus: route({ method: "GET", path: "/v1/update", output: type<UpdateStatus | null>() }),
  checkUpdate: route({
    method: "POST",
    path: "/v1/update/check",
    body: EmptyBody,
    output: type<UpdateStatus>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  applyUpdate: route({
    method: "POST",
    path: "/v1/update/apply",
    body: UpdateApplyInput,
    output: type<UpdateStatus>(),
  }),
  rollbackUpdate: route({
    method: "POST",
    path: "/v1/update/rollback",
    body: EmptyBody,
    output: type<UpdateStatus>(),
  }),

  listRepos: route({ method: "GET", path: "/v1/repos", output: type<Repository[]>() }),
  listProfiles: route({ method: "GET", path: "/v1/profiles", output: type<Profile[]>() }),

  dispatch: route({
    method: "POST",
    path: "/v1/tasks",
    body: DispatchTaskInput,
    output: type<{ task: Task; created: boolean }>(),
  }),
  listTasks: route({
    method: "GET",
    path: "/v1/tasks",
    query: TaskListQuery,
    output: type<TaskView[]>(),
  }),
  inspectTask: route({ method: "GET", path: task(), params: IdParams, output: type<TaskDetail>() }),
  taskProgress: route({
    method: "GET",
    path: task("/progress"),
    params: IdParams,
    output: type<TaskProgress>(),
  }),
  peekTask: route({
    method: "GET",
    path: task("/transcript"),
    params: IdParams,
    query: TranscriptQuery,
    output: type<TaskTranscript>(),
  }),
  sendToWorker: route({
    method: "POST",
    path: task("/send"),
    params: IdParams,
    body: SendToWorkerInput,
    output: type<Task>(),
  }),
  cancelTask: route({
    method: "POST",
    path: task("/cancel"),
    params: IdParams,
    body: CancelTaskInput,
    output: type<Task>(),
  }),
  cleanupTask: route({
    method: "POST",
    path: task("/cleanup"),
    params: IdParams,
    body: CleanupTaskInput,
    output: type<Task>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  openPullRequest: route({
    method: "POST",
    path: task("/pull-request"),
    params: IdParams,
    body: OpenPullRequestInput,
    output: type<Task>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  mergePullRequest: route({
    method: "POST",
    path: task("/merge"),
    params: IdParams,
    body: MergePullRequestInput,
    output: type<Task>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  taskDiff: route({
    method: "GET",
    path: task("/diff"),
    params: IdParams,
    output: type<TaskDiff>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  requestChanges: route({
    method: "POST",
    path: task("/request-changes"),
    params: IdParams,
    body: RequestChangesInput,
    output: type<Task>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  landPlan: route({
    method: "GET",
    path: task("/land"),
    params: IdParams,
    output: type<LandPlan>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  landTask: route({
    method: "POST",
    path: task("/land"),
    params: IdParams,
    body: LandTaskInput,
    output: type<LandResult>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  discardTask: route({
    method: "POST",
    path: task("/discard"),
    params: IdParams,
    body: DiscardTaskInput,
    output: type<Task>(),
    timeoutMs: LONG_CALL_TIMEOUT_MS,
  }),
  acceptTask: route({
    method: "POST",
    path: task("/accept"),
    params: IdParams,
    output: type<Task>(),
  }),
  takeOverTask: route({
    method: "POST",
    path: task("/takeover"),
    params: IdParams,
    output: type<TakeOverResult>(),
  }),
  giveBackTask: route({
    method: "POST",
    path: task("/giveback"),
    params: IdParams,
    body: GiveBackInput,
    output: type<Task>(),
  }),
  resumeTask: route({
    method: "POST",
    path: task("/resume"),
    params: IdParams,
    body: ResumeTaskInput,
    output: type<Task>(),
  }),

  listAttention: route({
    method: "GET",
    path: "/v1/attention",
    query: AttentionListQuery,
    output: type<Attention[]>(),
  }),
  resolveAttention: route({
    method: "POST",
    path: "/v1/attention/:id/resolve",
    params: IdParams,
    body: ResolveAttentionInput,
    output: type<Attention>(),
  }),

  remember: route({
    method: "POST",
    path: "/v1/memories",
    body: RememberInput,
    output: type<Memory>(),
  }),
  recall: route({
    method: "POST",
    path: "/v1/memories/search",
    body: RecallInput,
    output: type<RecallHit[]>(),
  }),
  listMemories: route({
    method: "GET",
    path: "/v1/memories",
    query: MemoryListQuery,
    output: type<Memory[]>(),
  }),
  confirmMemory: route({
    method: "POST",
    path: "/v1/memories/:id/confirm",
    params: IdParams,
    output: type<Memory>(),
  }),
  forget: route({
    method: "DELETE",
    path: "/v1/memories/:id",
    params: IdParams,
    output: type<{ deleted: boolean }>(),
  }),
  recordDecision: route({
    method: "POST",
    path: "/v1/decisions",
    body: DecisionInput,
    output: type<Decision>(),
  }),
  listDecisions: route({
    method: "GET",
    path: "/v1/decisions",
    query: DecisionListQuery,
    output: type<Decision[]>(),
  }),

  getManager: route({ method: "GET", path: "/v1/manager", output: type<ManagerInfo>() }),
  briefing: route({ method: "GET", path: "/v1/briefing", output: type<Briefing>() }),
  listOutbox: route({
    method: "GET",
    path: "/v1/outbox",
    query: OutboxListQuery,
    output: type<OutboxEntry[]>(),
  }),
} as const;

/** Fills a route's `:name` segments from `params`. */
export function routePath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
}

// A route's schema slot is `undefined` when it takes no such part.
type Part<S, Key extends string, Value> = [NonNullable<S>] extends [never]
  ? unknown
  : { [K in Key]: Value };
type Input<S> = NonNullable<S> extends z.ZodType ? z.input<NonNullable<S>> : never;
type Parsed<S> = NonNullable<S> extends z.ZodType ? z.output<NonNullable<S>> : undefined;

export type QueryValues = Record<string, string | number | boolean | string[] | undefined>;

/** What a caller supplies for a route: only the parts the route declares. */
export type RouteArgs<R extends AnyRoute> = Part<R["params"], "params", Input<R["params"]>> &
  Part<R["body"], "body", Input<R["body"]>> &
  ([NonNullable<R["query"]>] extends [never] ? unknown : { query?: QueryValues });

/** What a handler receives for a route: the parts it declares, parsed. */
export interface ParsedRequest<R extends AnyRoute> {
  params: Parsed<R["params"]>;
  query: Parsed<R["query"]>;
  body: Parsed<R["body"]>;
}

export type RouteOutput<R extends AnyRoute> =
  R extends Route<Schema, Schema, Schema, infer O> ? O : never;
