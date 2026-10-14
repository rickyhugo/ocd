import { readFileSync } from "node:fs";
import { request } from "node:http";

import type {
  Actor,
  Attention,
  AttentionResponse,
  Briefing,
  Decision,
  DecisionInput,
  DispatchTaskInput,
  GiveBackInput,
  ManagerInfo,
  Memory,
  OutboxEntry,
  Profile,
  RecallHit,
  RecallInput,
  RememberInput,
  Repository,
  ShutdownReport,
  SupervisorStatus,
  LandPlan,
  LandResult,
  LandTaskInput,
  TakeOverResult,
  Task,
  TaskDetail,
  TaskFilter,
  TaskProgress,
} from "./schemas.ts";
import { apiTokenPath } from "./paths.ts";
import type { PeekTaskInput, TaskTranscript } from "./transcript.ts";
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

  withSession(sessionId: string): OcdClient {
    return new OcdClient({ ...this.options, sessionId });
  }

  async call<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
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
      req.setTimeout(this.options.timeoutMs ?? 30_000, () =>
        req.destroy(new Error("Request timed out")),
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

  status = () => this.call<SupervisorStatus>("GET", "/v1/status");
  pause = () => this.call<{ paused: boolean }>("POST", "/v1/pause");
  resume = () => this.call<{ paused: boolean }>("POST", "/v1/resume");
  shutdown = () => this.call<ShutdownReport>("POST", "/v1/shutdown");

  listRepos = () => this.call<Repository[]>("GET", "/v1/repos");
  listProfiles = () => this.call<Profile[]>("GET", "/v1/profiles");

  dispatch = (input: DispatchTaskInput) =>
    this.call<{ task: Task; created: boolean }>("POST", "/v1/tasks", input);
  listTasks = (filter: TaskFilter = {}) =>
    this.call<Task[]>("GET", "/v1/tasks", undefined, {
      state: filter.state,
      repo: filter.repo,
      open: filter.open,
      limit: filter.limit,
    });
  inspectTask = (id: string) => this.call<TaskDetail>("GET", `/v1/tasks/${encodeURIComponent(id)}`);
  /** Latest checklist and recent events of one task; read-only. */
  taskProgress = (id: string) =>
    this.call<TaskProgress>("GET", `/v1/tasks/${encodeURIComponent(id)}/progress`);
  sendToWorker = (id: string, instructions: string) =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/send`, { instructions });
  cancelTask = (id: string, reason?: string) =>
    this.call<Task>(
      "POST",
      `/v1/tasks/${encodeURIComponent(id)}/cancel`,
      reason === undefined ? {} : { reason },
    );
  cleanupTask = (id: string, force = false) =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/cleanup`, { force });
  openPullRequest = (
    id: string,
    options: { draft?: boolean; base?: string; commit?: boolean } = {},
  ) => this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/pull-request`, options);
  mergePullRequest = (id: string, method?: "squash" | "merge" | "rebase") =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/merge`, method ? { method } : {});
  /** What a direct landing would push (fetches the base; changes nothing). */
  landPlan = (id: string) => this.call<LandPlan>("GET", `/v1/tasks/${encodeURIComponent(id)}/land`);
  /** Gets the work into its base branch: through a pull request, or directly once confirmed. */
  landTask = (id: string, input: LandTaskInput = {}) =>
    this.call<LandResult>("POST", `/v1/tasks/${encodeURIComponent(id)}/land`, input);
  /** Cancels the task if needed and removes its worktree and branch, losing their work. Human only. */
  discardTask = (id: string, reason?: string) =>
    this.call<Task>(
      "POST",
      `/v1/tasks/${encodeURIComponent(id)}/discard`,
      reason === undefined ? {} : { reason },
    );
  acceptTask = (id: string) =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/accept`);
  /** Manual mode: stops OCD driving the worker and returns the command to open the session. Human only. */
  takeOverTask = (id: string) =>
    this.call<TakeOverResult>("POST", `/v1/tasks/${encodeURIComponent(id)}/takeover`);
  /** Ends manual mode: the worker continues headless, or the task goes to review. Human only. */
  giveBackTask = (id: string, input: GiveBackInput) =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/giveback`, input);
  resumeTask = (id: string, mode: "reattach" | "relaunch") =>
    this.call<Task>("POST", `/v1/tasks/${encodeURIComponent(id)}/resume`, { mode });
  /** Read-only view of a worker's recent messages and tool activity. Never touches the worker. */
  peekTask = (id: string, options: PeekTaskInput = {}) =>
    this.call<TaskTranscript>("GET", `/v1/tasks/${encodeURIComponent(id)}/transcript`, undefined, {
      limit: options.limit,
      before: options.before,
      reasoningSummaries: options.reasoningSummaries,
    });

  listAttention = (query: { status?: string; taskId?: string; limit?: number } = {}) =>
    this.call<Attention[]>("GET", "/v1/attention", undefined, query);
  resolveAttention = (id: string, response: AttentionResponse) =>
    this.call<Attention>("POST", `/v1/attention/${encodeURIComponent(id)}/resolve`, { response });

  remember = (input: RememberInput) => this.call<Memory>("POST", "/v1/memories", input);
  recall = (input: RecallInput) => this.call<RecallHit[]>("POST", "/v1/memories/search", input);
  listMemories = (query: { status?: string; scope?: string; repo?: string } = {}) =>
    this.call<Memory[]>("GET", "/v1/memories", undefined, query);
  confirmMemory = (id: string) =>
    this.call<Memory>("POST", `/v1/memories/${encodeURIComponent(id)}/confirm`);
  forget = (id: string) =>
    this.call<{ deleted: boolean }>("DELETE", `/v1/memories/${encodeURIComponent(id)}`);

  recordDecision = (input: DecisionInput) => this.call<Decision>("POST", "/v1/decisions", input);
  listDecisions = (query: { repo?: string; taskId?: string } = {}) =>
    this.call<Decision[]>("GET", "/v1/decisions", undefined, query);

  getManager = () => this.call<ManagerInfo>("GET", "/v1/manager");
  briefing = () => this.call<Briefing>("GET", "/v1/briefing");

  listOutbox = (query: { status?: string } = {}) =>
    this.call<OutboxEntry[]>("GET", "/v1/outbox", undefined, query);
}
