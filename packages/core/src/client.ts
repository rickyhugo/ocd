import { readFileSync } from "node:fs";
import { request } from "node:http";

import {
  routePath,
  routes,
  type AnyRoute,
  type RouteArgs,
  type RouteOutput,
} from "./api-contract.ts";
import type {
  Actor,
  AttentionResponse,
  DecisionInput,
  DispatchTaskInput,
  GiveBackInput,
  LandTaskInput,
  MergeMethod,
  RecallInput,
  RememberInput,
  TaskFilter,
} from "./schemas.ts";
import { apiTokenPath } from "./paths.ts";
import type { PeekTaskInput } from "./transcript.ts";
import {
  API_VERSION,
  HEADER_ACTOR,
  HEADER_API_VERSION,
  HEADER_DIRECTORY,
  HEADER_SESSION,
} from "./version.ts";

export class OcdApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "OcdApiError";
  }
}

export class SupervisorUnavailableError extends Error {
  constructor(socketPath: string, cause: unknown) {
    super(`OCD supervisor is not reachable at ${socketPath}. Start it with \`ocd daemon\`.`, {
      cause,
    });
    this.name = "SupervisorUnavailableError";
  }
}

export interface ClientOptions {
  socketPath: string;
  actor: Actor;
  /** OpenCode session the request originates from (plugin calls). */
  sessionId?: string;
  /** Working directory of that session; decides whether it is the manager. */
  directory?: string;
  timeoutMs?: number;
  /**
   * API token. Defaults to reading the token file next to the socket on each
   * request, so a supervisor restart or token rotation needs no new client.
   */
  token?: string;
}

/** HTTP header carrying the API token. */
export const HEADER_AUTHORIZATION = "authorization";

type Query = Record<string, string | number | boolean | string[] | undefined>;

function toQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function readToken(socketPath: string): string | null {
  try {
    return readFileSync(apiTokenPath(socketPath), "utf8").trim() || null;
  } catch {
    // No token file: requests go out unauthenticated and are refused.
    return null;
  }
}

/** Typed client for the supervisor's HTTP API over its Unix socket. */
export class OcdClient {
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Query,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: "application/json",
      [HEADER_API_VERSION]: String(API_VERSION),
      [HEADER_ACTOR]: this.options.actor,
    };
    const token = this.options.token ?? readToken(this.options.socketPath);
    if (token) headers[HEADER_AUTHORIZATION] = `Bearer ${token}`;
    if (this.options.sessionId) headers[HEADER_SESSION] = this.options.sessionId;
    if (this.options.directory)
      headers[HEADER_DIRECTORY] = encodeURIComponent(this.options.directory);
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    return new Promise<T>((resolvePromise, reject) => {
      const req = request(
        // No pooling: a pooled socket would outlive a supervisor restart.
        {
          socketPath: this.options.socketPath,
          path: `${path}${toQuery(query)}`,
          method,
          headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          const broken = (cause?: Error) =>
            reject(
              new OcdApiError(
                res.statusCode ?? 0,
                "connection_lost",
                `The connection to the supervisor dropped mid-response${cause ? ` (${cause.message})` : ""}. The operation may still have completed; check \`ocd task show\`.`,
              ),
            );
          res.on("error", broken);
          res.on("aborted", () => broken());
          res.on("close", () => {
            if (!res.complete) broken();
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = undefined;
            try {
              json = text ? JSON.parse(text) : undefined;
            } catch {
              reject(
                new OcdApiError(
                  res.statusCode ?? 0,
                  "bad_response",
                  `Non-JSON response: ${text.slice(0, 200)}`,
                ),
              );
              return;
            }
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const err = (
                json as { error?: { code?: string; message?: string; details?: unknown } }
              )?.error;
              reject(
                new OcdApiError(
                  status,
                  err?.code ?? "error",
                  err?.message ?? `HTTP ${status}`,
                  err?.details,
                ),
              );
              return;
            }
            resolvePromise(json as T);
          });
        },
      );
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
      req.setTimeout(timeoutMs, () =>
        req.destroy(
          new Error(
            `Request timed out after ${Math.round(timeoutMs / 1000)}s without a response. The supervisor may still be running the operation; check \`ocd task show\` before retrying.`,
          ),
        ),
      );
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          reject(new SupervisorUnavailableError(this.options.socketPath, error));
        } else {
          reject(error);
        }
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Sends one route of the API contract: path, method, timeout and input types come from it. */
  private send<R extends AnyRoute>(
    route: R,
    ...[args]: {} extends RouteArgs<R> ? [args?: RouteArgs<R>] : [args: RouteArgs<R>]
  ): Promise<RouteOutput<R>> {
    const { params, query, body } = (args ?? {}) as {
      params?: Record<string, string>;
      query?: Query;
      body?: unknown;
    };
    return this.call(
      route.method,
      routePath(route.path, params),
      body,
      query,
      route.timeoutMs ? { timeoutMs: route.timeoutMs } : {},
    );
  }

  status = () => this.send(routes.status);
  pause = () => this.send(routes.pause);
  resume = () => this.send(routes.resume);
  shutdown = () => this.send(routes.shutdown);

  listRepos = () => this.send(routes.listRepos);
  listProfiles = () => this.send(routes.listProfiles);

  dispatch = (input: DispatchTaskInput) => this.send(routes.dispatch, { body: input });
  listTasks = (filter: TaskFilter = {}) =>
    this.send(routes.listTasks, {
      query: {
        state: filter.state,
        repo: filter.repo,
        open: filter.open,
        limit: filter.limit,
      },
    });
  inspectTask = (id: string) => this.send(routes.inspectTask, { params: { id } });
  /** Latest checklist and recent events of one task; read-only. */
  taskProgress = (id: string) => this.send(routes.taskProgress, { params: { id } });
  sendToWorker = (id: string, instructions: string) =>
    this.send(routes.sendToWorker, { params: { id }, body: { instructions } });
  cancelTask = (id: string, reason?: string) =>
    this.send(routes.cancelTask, {
      params: { id },
      body: reason === undefined ? {} : { reason },
    });
  cleanupTask = (id: string, force = false) =>
    this.send(routes.cleanupTask, { params: { id }, body: { force } });
  openPullRequest = (
    id: string,
    options: { draft?: boolean; base?: string; commit?: boolean } = {},
  ) => this.send(routes.openPullRequest, { params: { id }, body: options });
  mergePullRequest = (id: string, method?: MergeMethod) =>
    this.send(routes.mergePullRequest, { params: { id }, body: method ? { method } : {} });
  /** The task's changes against where its branch started, uncommitted ones included. Read-only. */
  taskDiff = (id: string) => this.send(routes.taskDiff, { params: { id } });
  /** Sends review feedback to the worker and reopens the task; recorded as a review round. */
  requestChanges = (id: string, feedback: string) =>
    this.send(routes.requestChanges, { params: { id }, body: { feedback } });
  /** What a direct landing would push (fetches the base; changes nothing). */
  landPlan = (id: string) => this.send(routes.landPlan, { params: { id } });
  /** Subscription usage limits the harnesses reported (usageLimits). */
  usage = () => this.send(routes.usage);
  /** Reads the limits that cost no tokens to read now. */
  refreshUsage = () => this.send(routes.refreshUsage, { body: {} });

  /** OCD's own update state (selfUpdate). */
  updateStatus = () => this.send(routes.updateStatus);
  /** Fetches and, when there is a new version, builds and smoke-tests it (can take minutes). */
  checkUpdate = () => this.send(routes.checkUpdate, { body: {} });
  /** Switches to the pending version; `force` interrupts workers a restart would interrupt. Human only. */
  applyUpdate = (force = false) => this.send(routes.applyUpdate, { body: { force } });
  /** Back to the previous version. Human only. */
  rollbackUpdate = () => this.send(routes.rollbackUpdate, { body: {} });
  /** Gets the work into its base branch: through a pull request, or directly once confirmed. */
  landTask = (id: string, input: LandTaskInput = {}) =>
    this.send(routes.landTask, { params: { id }, body: input });
  /** Cancels the task if needed and removes its worktree and branch, losing their work. Human only. */
  discardTask = (id: string, reason?: string) =>
    this.send(routes.discardTask, {
      params: { id },
      body: reason === undefined ? {} : { reason },
    });
  acceptTask = (id: string) => this.send(routes.acceptTask, { params: { id } });
  /** Manual mode: stops OCD driving the worker and returns the command to open the session. Human only. */
  takeOverTask = (id: string) => this.send(routes.takeOverTask, { params: { id } });
  /** Ends manual mode: the worker continues headless, or the task goes to review. Human only. */
  giveBackTask = (id: string, input: GiveBackInput) =>
    this.send(routes.giveBackTask, { params: { id }, body: input });
  resumeTask = (id: string, mode: "reattach" | "relaunch") =>
    this.send(routes.resumeTask, { params: { id }, body: { mode } });
  /** Read-only view of a worker's recent messages and tool activity. Never touches the worker. */
  peekTask = (id: string, options: PeekTaskInput = {}) =>
    this.send(routes.peekTask, {
      params: { id },
      query: {
        limit: options.limit,
        before: options.before,
        reasoningSummaries: options.reasoningSummaries,
      },
    });

  listAttention = (query: { status?: string; taskId?: string; limit?: number } = {}) =>
    this.send(routes.listAttention, { query });
  resolveAttention = (id: string, response: AttentionResponse) =>
    this.send(routes.resolveAttention, { params: { id }, body: { response } });

  remember = (input: RememberInput) => this.send(routes.remember, { body: input });
  recall = (input: RecallInput) => this.send(routes.recall, { body: input });
  listMemories = (query: { status?: string; scope?: string; repo?: string } = {}) =>
    this.send(routes.listMemories, { query });
  confirmMemory = (id: string) => this.send(routes.confirmMemory, { params: { id } });
  forget = (id: string) => this.send(routes.forget, { params: { id } });

  recordDecision = (input: DecisionInput) => this.send(routes.recordDecision, { body: input });
  listDecisions = (query: { repo?: string; taskId?: string } = {}) =>
    this.send(routes.listDecisions, { query });

  getManager = () => this.send(routes.getManager);
  briefing = () => this.send(routes.briefing);

  listOutbox = (query: { status?: string } = {}) => this.send(routes.listOutbox, { query });
}
