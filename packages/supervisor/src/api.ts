import { MANAGER_HOST } from "@ocd/adapters";
import {
  API_VERSION,
  Actor,
  HEADER_ACTOR,
  HEADER_API_VERSION,
  HEADER_AUTHORIZATION,
  HEADER_DIRECTORY,
  HEADER_SESSION,
  TaskStateSchema,
  redact,
  routes,
  usageLines,
  type AnyRoute,
  type ApiErrorBody,
  type Briefing,
  type ErrorCode,
  type ManagerInfo,
  type ParsedRequest,
  type ShutdownReport,
  type TaskDetail,
  type TaskProgress,
} from "@ocd/core";
import { timingSafeEqual } from "node:crypto";

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError } from "zod";

import { normalizeDirectory, type LiveConfig } from "./config.ts";
import { DomainError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { MemoryService } from "./memory.ts";
import type { Store } from "./store.ts";
import type { SelfUpdater } from "./self-update.ts";
import type { UsageTracker } from "./usage.ts";
import type { Supervisor } from "./supervisor.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
    sessionId: string | null;
    directory: string | null;
  }
}

export interface ApiDeps {
  /** Every request must present it; only OCD's own clients can read it. */
  apiToken: string;
  store: Store;
  supervisor: Supervisor;
  memory: MemoryService;
  logger: Logger;
  /** Invoked after the shutdown response is sent. */
  requestShutdown: () => Promise<ShutdownReport>;
  live: LiveConfig;
  /** Self-update; null when this daemon does not manage OCD's own installs. */
  updater: SelfUpdater | null;
  /** Subscription usage limits; absent in tests that do not need it. */
  usage?: UsageTracker;
}

/** The HTTP status for each error code; the only place codes meet HTTP. */
const HTTP_STATUS: Record<ErrorCode, number> = {
  actor_required: 400,
  api_version_required: 400,
  bad_request: 400,
  bad_response: 400,
  branch_collision: 409,
  cleanup_failed: 409,
  confirmation_required: 409,
  empty_query: 400,
  expired: 410,
  fetch_failed: 409,
  gh_auth_required: 422,
  gh_failed: 502,
  gh_not_found: 422,
  gh_unreachable: 503,
  harness_disabled: 422,
  harness_unavailable: 422,
  harness_unsupported: 422,
  has_pull_request: 409,
  human_only: 403,
  idempotency_mismatch: 409,
  incompatible_api_version: 400,
  internal: 500,
  invalid_cursor: 400,
  invalid_request: 400,
  land_conflict: 409,
  land_unsupported: 409,
  looks_like_secret: 400,
  manual_mode: 403,
  no_manager: 403,
  no_pull_request: 409,
  no_session: 409,
  no_workspace: 409,
  not_a_repo: 400,
  not_accepted: 409,
  not_finished: 409,
  not_found: 404,
  not_manager: 403,
  not_manual: 409,
  not_open: 409,
  not_repo_root: 400,
  not_resumable: 409,
  not_reviewable: 409,
  not_steerable: 409,
  not_supported: 409,
  not_takeoverable: 409,
  nothing_to_push: 409,
  plan_changed: 409,
  pr_blocked: 409,
  pr_checks_failed: 409,
  pr_checks_pending: 409,
  pr_closed: 409,
  pr_conflicts: 409,
  pr_draft: 409,
  pr_not_ready: 409,
  pr_unavailable: 422,
  profile_required: 400,
  push_rejected: 409,
  repo_in_workspaces: 400,
  repo_missing: 400,
  repo_moved: 409,
  retired: 400,
  rollback_unsafe: 409,
  scope_mismatch: 400,
  session_in_use: 409,
  session_missing: 409,
  stale_request: 409,
  state_changed: 409,
  task_finished: 409,
  unauthenticated: 401,
  unmerged_commits: 409,
  unsupported_capability: 422,
  update_disabled: 409,
  update_no_previous: 409,
  update_no_repo: 409,
  update_not_installed: 403,
  update_unavailable: 409,
  worker_session: 403,
  workspace_collision: 409,
  workspace_dirty: 409,
};

export function buildApi(deps: ApiDeps): FastifyInstance {
  const { store, supervisor, memory } = deps;
  const app = Fastify({
    loggerInstance: deps.logger.child({ component: "api" }) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_048_576,
  });

  app.decorateRequest("actor", "human");
  app.decorateRequest("sessionId", null);
  app.decorateRequest("directory", null);

  const expected = Buffer.from(`Bearer ${deps.apiToken}`);
  app.addHook("onRequest", async (req) => {
    // Authentication before anything else: the actor header below only
    // chooses between trusted clients, it never grants authority by itself.
    const presented = Buffer.from(String(req.headers[HEADER_AUTHORIZATION] ?? ""));
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new DomainError(
        "unauthenticated",
        "OCD's API only accepts its own clients (the ocd CLI, the TUI and the manager plugin). Workers report through their final message instead.",
      );
    }
    const version = req.headers[HEADER_API_VERSION];
    if (version === undefined)
      throw new DomainError("api_version_required", `Missing ${HEADER_API_VERSION} header`);
    if (Number(version) !== API_VERSION) {
      throw new DomainError(
        "incompatible_api_version",
        `Client speaks API v${String(version)}, supervisor speaks v${API_VERSION}`,
      );
    }
    const actor = Actor.safeParse(req.headers[HEADER_ACTOR]);
    if (!actor.success)
      throw new DomainError("actor_required", `Missing or invalid ${HEADER_ACTOR} header`);
    req.actor = actor.data;
    const session = req.headers[HEADER_SESSION];
    req.sessionId = typeof session === "string" && session ? session : null;
    const directory = req.headers[HEADER_DIRECTORY];
    try {
      req.directory =
        typeof directory === "string" && directory ? decodeURIComponent(directory) : null;
    } catch {
      throw new DomainError("bad_request", `Malformed ${HEADER_DIRECTORY} header`);
    }
    if (req.sessionId && store.isWorkerSession(req.sessionId)) {
      // Plugins load in worker sessions too; workers never get control-plane tools.
      throw new DomainError("worker_session", "Worker sessions cannot use OCD control tools");
    }
  });

  /** Manager calls must come from the registered manager session. */
  /**
   * Manager calls must come from a session in the configured manager
   * directory. The latest such session becomes the one that receives updates.
   */
  function requireCaller(req: FastifyRequest): void {
    if (req.actor !== "manager") return;
    const managerDirectory = deps.live.managerDirectory;
    if (!managerDirectory) {
      throw new DomainError(
        "no_manager",
        "No manager is configured. Set manager.directory in ocd.jsonc.",
      );
    }
    if (
      !req.sessionId ||
      !req.directory ||
      normalizeDirectory(req.directory) !== managerDirectory
    ) {
      throw new DomainError(
        "not_manager",
        `Only ${MANAGER_HOST.label} sessions started in ${managerDirectory} may use OCD control tools`,
      );
    }
    store.activateManager(req.sessionId, managerDirectory);
  }

  app.setErrorHandler((error, req, reply) => {
    let status: number | undefined;
    let body: ApiErrorBody;
    if (error instanceof ZodError) {
      body = {
        error: {
          code: "invalid_request",
          message: "Request failed validation",
          details: error.issues,
        },
      };
    } else if (error instanceof DomainError) {
      body = { error: { code: error.code, message: error.message, details: error.details } };
    } else if (
      typeof (error as { statusCode?: number }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode < 500
    ) {
      // Fastify's own request errors (an oversized or malformed body) keep their status.
      status = (error as { statusCode: number }).statusCode;
      body = { error: { code: "bad_request", message: (error as Error).message } };
    } else if ((error as { name?: string }).name === "UnsupportedCapabilityError") {
      body = { error: { code: "unsupported_capability", message: (error as Error).message } };
    } else {
      req.log.error({ err: error }, "request failed");
      body = {
        error: { code: "internal", message: redact((error as Error).message ?? "Internal error") },
      };
    }
    void reply.status(status ?? HTTP_STATUS[body.error.code]).send(body);
  });

  /**
   * Registers a handler against its contract entry: path and method come from
   * the route, and params, query and body are parsed with its schemas before
   * the handler runs. Manager calls are checked first unless `caller: false`.
   */
  function register<R extends AnyRoute>(
    route: R,
    handler: (ctx: ParsedRequest<R> & { req: FastifyRequest; reply: FastifyReply }) => unknown,
    options: { caller?: boolean } = {},
  ): void {
    app.route({
      method: route.method,
      url: route.path,
      handler: async (req, reply) => {
        if (options.caller !== false) requireCaller(req);
        return handler({
          req,
          reply,
          params: route.params?.parse(req.params),
          query: route.query?.parse(req.query),
          body: route.body?.parse(req.body ?? {}),
        } as ParsedRequest<R> & { req: FastifyRequest; reply: FastifyReply });
      },
    });
  }

  // -- status and lifecycle --------------------------------------------------
  register(
    routes.status,
    () => ({
      ...supervisor.status(),
      update: deps.updater?.status() ?? null,
      usage: deps.usage?.status() ?? null,
    }),
    { caller: false },
  );
  register(routes.usage, () => deps.usage?.status() ?? { harnesses: [], notifyAt: [] }, {
    caller: false,
  });
  /** Reads the limits that can be read without a model call now. */
  register(routes.refreshUsage, () =>
    deps.usage ? deps.usage.refresh() : { harnesses: [], notifyAt: [] },
  );
  const updater = () => {
    if (!deps.updater)
      throw new DomainError(
        "update_unavailable",
        "This supervisor does not manage OCD's own updates",
      );
    return deps.updater;
  };
  register(routes.updateStatus, () => deps.updater?.status() ?? null, { caller: false });
  register(routes.checkUpdate, () => updater().check());
  /** Switch to the pending version now; `force` interrupts workers a restart would interrupt. Human only. */
  register(routes.applyUpdate, ({ req, body }) => {
    if (req.actor !== "human")
      throw new DomainError("human_only", "Only a human can apply an update");
    return updater().tryApply(body.force);
  });
  register(routes.rollbackUpdate, ({ req }) => {
    if (req.actor !== "human") throw new DomainError("human_only", "Only a human can roll back");
    return updater().rollback();
  });
  register(routes.pause, () => {
    supervisor.setPaused(true);
    return { paused: true };
  });
  register(routes.resume, () => {
    supervisor.setPaused(false);
    return { paused: false };
  });
  register(
    routes.shutdown,
    async ({ req, reply }) => {
      if (req.actor !== "human")
        throw new DomainError("human_only", "Only a human can stop the supervisor");
      const report = await deps.requestShutdown();
      return reply.send(report);
    },
    { caller: false },
  );

  // -- repositories and profiles (declared in ocd.jsonc) ---------------------------
  register(routes.listRepos, () => store.listRepos());
  register(routes.listProfiles, () => deps.live.listProfiles());

  // -- tasks -------------------------------------------------------------------
  register(routes.dispatch, ({ body, reply }) => {
    const result = supervisor.dispatch(body);
    return reply.status(result.created ? 201 : 200).send(result);
  });
  register(routes.listTasks, ({ query }) => {
    const states =
      query.state ??
      (query.open
        ? TaskStateSchema.options.filter((s) => s !== "completed" && s !== "cancelled")
        : undefined);
    return store.listTasks({
      ...(states ? { state: states } : {}),
      ...(query.repo ? { repo: query.repo } : {}),
      limit: query.limit,
    });
  });
  register(routes.inspectTask, ({ params }): TaskDetail => ({
    task: store.requireTask(params.id),
    runs: store.runs(params.id),
    events: store.events(params.id),
    attention: store.listAttention({ taskId: params.id }),
  }));
  register(routes.taskProgress, ({ params }): TaskProgress => supervisor.taskProgress(params.id));
  // Read-only: any authenticated caller that may inspect tasks may peek, in
  // every task state (manual mode included); it never changes the worker.
  register(routes.peekTask, ({ params, query }) => supervisor.peek(params.id, query));
  register(routes.sendToWorker, ({ params, body }) =>
    supervisor.sendToWorker(params.id, body.instructions),
  );
  register(routes.cancelTask, ({ req, params, body }) => {
    if (req.actor !== "human" && store.requireTask(params.id).state === "manual")
      throw new DomainError(
        "manual_mode",
        "The human is driving this task; only they can cancel it",
      );
    return supervisor.cancel(params.id, body.reason);
  });
  register(routes.cleanupTask, ({ req, params, body }) =>
    supervisor.cleanup(params.id, body.force, req.actor),
  );
  register(routes.openPullRequest, ({ req, params, body }) =>
    supervisor.openPullRequest(params.id, body, req.actor),
  );
  register(routes.mergePullRequest, ({ req, params, body }) =>
    supervisor.mergePullRequest(params.id, { method: body.method }, req.actor),
  );
  register(routes.taskDiff, ({ params }) => supervisor.diff(params.id));
  register(routes.requestChanges, ({ req, params, body }) =>
    supervisor.requestChanges(params.id, body.feedback, req.actor),
  );
  register(routes.landPlan, ({ params }) => supervisor.landPlan(params.id));
  register(routes.landTask, ({ req, params, body }) => supervisor.land(params.id, body, req.actor));
  register(routes.discardTask, ({ req, params, body }) =>
    supervisor.discard(params.id, body.reason, req.actor),
  );
  register(routes.acceptTask, ({ req, params }) => supervisor.accept(params.id, req.actor));
  register(routes.takeOverTask, ({ req, params }) => supervisor.takeOver(params.id, req.actor), {
    caller: false,
  });
  register(
    routes.giveBackTask,
    ({ req, params, body }) => supervisor.giveBack(params.id, body.mode, body.note, req.actor),
    { caller: false },
  );
  register(
    routes.resumeTask,
    ({ req, params, body }) => supervisor.resume(params.id, body.mode, req.actor),
    { caller: false },
  );

  // -- attention ---------------------------------------------------------------
  register(routes.listAttention, ({ query }) =>
    store.listAttention({
      ...(query.status ? { status: query.status } : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
      limit: query.limit,
    }),
  );
  register(routes.resolveAttention, ({ req, params, body }) =>
    supervisor.resolveAttention(params.id, body.response, req.actor),
  );

  // -- memory and decisions ----------------------------------------------------
  register(routes.remember, ({ req, body }) => memory.remember(body, req.actor));
  register(routes.recall, ({ body }) => memory.recall(body));
  register(routes.listMemories, ({ query }) => {
    const repo = query.repo ? store.requireRepo(query.repo) : null;
    return store.listMemories({
      ...(query.status ? { status: query.status } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(repo ? { repoId: repo.id } : {}),
    });
  });
  register(routes.confirmMemory, ({ req, params }) => memory.confirm(params.id, req.actor), {
    caller: false,
  });
  register(routes.forget, ({ req, params }) => ({ deleted: memory.forget(params.id, req.actor) }));
  register(routes.recordDecision, ({ req, body }) => memory.recordDecision(body, req.actor));
  register(routes.listDecisions, ({ query }) => {
    const repo = query.repo ? store.requireRepo(query.repo) : null;
    return store.listDecisions({
      ...(repo ? { repoId: repo.id } : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
    });
  });

  // -- manager -----------------------------------------------------------------
  register(
    routes.getManager,
    (): ManagerInfo => ({
      directory: deps.live.managerDirectory,
      active: store.activeManager(),
    }),
    { caller: false },
  );
  register(routes.briefing, (): Briefing => {
    const briefing = memory.briefing();
    // Usage limits help the manager pick a profile whose harness has headroom.
    const usage = deps.usage?.status().harnesses ?? [];
    if (!usage.length) return briefing;
    return {
      ...briefing,
      usage,
      text: [
        briefing.text,
        "",
        "### Subscription usage limits (as the harnesses last reported)",
        ...usageLines(usage, Date.now()).map((line) => `- ${line}`),
        "Prefer profiles whose harness has headroom; a task that hits a limit waits for the reset.",
      ].join("\n"),
    };
  });

  register(routes.listOutbox, ({ query }) => store.listOutbox(query.status));

  return app;
}
