import {
  API_VERSION,
  Actor,
  AttentionFilter,
  CancelTaskInput,
  CleanupTaskInput,
  DiscardTaskInput,
  LandTaskInput,
  RequestChangesInput,
  MergePullRequestInput,
  OpenPullRequestInput,
  PeekTaskInput,
  DecisionInput,
  DispatchTaskInput,
  HEADER_ACTOR,
  HEADER_API_VERSION,
  HEADER_AUTHORIZATION,
  HEADER_DIRECTORY,
  HEADER_SESSION,
  RecallInput,
  RememberInput,
  ResolveAttentionInput,
  GiveBackInput,
  ResumeTaskInput,
  SendToWorkerInput,
  TaskFilter,
  TaskStateSchema,
  redact,
  type ApiErrorBody,
  type ManagerInfo,
  type ShutdownReport,
  type TaskDetail,
  type TaskProgress,
} from "@ocd/core";
import { timingSafeEqual } from "node:crypto";

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";

import { normalizeDirectory, type LiveConfig } from "./config.ts";
import { ApiError, conflict, forbidden } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { MemoryService } from "./memory.ts";
import type { Store } from "./store.ts";
import type { SelfUpdater } from "./self-update.ts";
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
}

const UpdateApplyInput = z.object({ force: z.boolean().default(false) });
const IdParams = z.object({ id: z.string().min(1).max(100) });

const csv = (value: unknown) => (typeof value === "string" && value ? value.split(",") : undefined);
const bool = (value: unknown) => (value === "true" ? true : value === "false" ? false : undefined);
const int = (value: unknown) => (typeof value === "string" && value ? Number(value) : undefined);

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
      throw new ApiError(
        401,
        "unauthenticated",
        "OCD's API only accepts its own clients (the ocd CLI, the TUI and the manager plugin). Workers report through their final message instead.",
      );
    }
    const version = req.headers[HEADER_API_VERSION];
    if (version === undefined)
      throw new ApiError(400, "api_version_required", `Missing ${HEADER_API_VERSION} header`);
    if (Number(version) !== API_VERSION) {
      throw new ApiError(
        400,
        "incompatible_api_version",
        `Client speaks API v${String(version)}, supervisor speaks v${API_VERSION}`,
      );
    }
    const actor = Actor.safeParse(req.headers[HEADER_ACTOR]);
    if (!actor.success)
      throw new ApiError(400, "actor_required", `Missing or invalid ${HEADER_ACTOR} header`);
    req.actor = actor.data;
    const session = req.headers[HEADER_SESSION];
    req.sessionId = typeof session === "string" && session ? session : null;
    const directory = req.headers[HEADER_DIRECTORY];
    try {
      req.directory =
        typeof directory === "string" && directory ? decodeURIComponent(directory) : null;
    } catch {
      throw new ApiError(400, "bad_request", `Malformed ${HEADER_DIRECTORY} header`);
    }
    if (req.sessionId && store.isWorkerSession(req.sessionId)) {
      // Plugins load in worker sessions too; workers never get control-plane tools.
      throw forbidden("worker_session", "Worker sessions cannot use OCD control tools");
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
      throw forbidden(
        "no_manager",
        "No manager is configured. Set manager.directory in ocd.jsonc.",
      );
    }
    if (
      !req.sessionId ||
      !req.directory ||
      normalizeDirectory(req.directory) !== managerDirectory
    ) {
      throw forbidden(
        "not_manager",
        `Only OpenCode sessions started in ${managerDirectory} may use OCD control tools`,
      );
    }
    store.activateManager(req.sessionId, managerDirectory);
  }

  app.setErrorHandler((error, req, reply) => {
    let status = 500;
    let body: ApiErrorBody;
    if (error instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: "invalid_request",
          message: "Request failed validation",
          details: error.issues,
        },
      };
    } else if (error instanceof ApiError) {
      status = error.status;
      body = { error: { code: error.code, message: error.message, details: error.details } };
    } else if (
      typeof (error as { statusCode?: number }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode < 500
    ) {
      status = (error as { statusCode: number }).statusCode;
      body = { error: { code: "bad_request", message: (error as Error).message } };
    } else if ((error as { name?: string }).name === "UnsupportedCapabilityError") {
      status = 422;
      body = { error: { code: "unsupported_capability", message: (error as Error).message } };
    } else {
      req.log.error({ err: error }, "request failed");
      body = {
        error: { code: "internal", message: redact((error as Error).message ?? "Internal error") },
      };
    }
    void reply.status(status).send(body);
  });

  // -- status and lifecycle --------------------------------------------------
  app.get("/v1/status", async () => ({
    ...supervisor.status(),
    update: deps.updater?.status() ?? null,
  }));
  const updater = () => {
    if (!deps.updater)
      throw conflict("update_unavailable", "This supervisor does not manage OCD's own updates");
    return deps.updater;
  };
  app.get("/v1/update", async () => deps.updater?.status() ?? null);
  app.post("/v1/update/check", async (req) => {
    requireCaller(req);
    return updater().check();
  });
  /** Switch to the pending version now; `force` interrupts Claude Code / Codex workers. Human only. */
  app.post("/v1/update/apply", async (req) => {
    requireCaller(req);
    if (req.actor !== "human") throw forbidden("human_only", "Only a human can apply an update");
    const { force } = UpdateApplyInput.parse(req.body ?? {});
    return updater().tryApply(force);
  });
  app.post("/v1/update/rollback", async (req) => {
    requireCaller(req);
    if (req.actor !== "human") throw forbidden("human_only", "Only a human can roll back");
    return updater().rollback();
  });
  app.post("/v1/pause", async (req) => {
    requireCaller(req);
    supervisor.setPaused(true);
    return { paused: true };
  });
  app.post("/v1/resume", async (req) => {
    requireCaller(req);
    supervisor.setPaused(false);
    return { paused: false };
  });
  app.post("/v1/shutdown", async (req, reply) => {
    if (req.actor !== "human")
      throw forbidden("human_only", "Only a human can stop the supervisor");
    const report = await deps.requestShutdown();
    return reply.send(report);
  });

  // -- repositories and profiles (declared in ocd.jsonc) ---------------------------
  app.get("/v1/repos", async (req) => {
    requireCaller(req);
    return store.listRepos();
  });
  app.get("/v1/profiles", async (req) => {
    requireCaller(req);
    return deps.live.listProfiles();
  });

  // -- tasks -------------------------------------------------------------------
  app.post("/v1/tasks", async (req, reply) => {
    requireCaller(req);
    const result = supervisor.dispatch(DispatchTaskInput.parse(req.body));
    return reply.status(result.created ? 201 : 200).send(result);
  });
  app.get("/v1/tasks", async (req) => {
    requireCaller(req);
    const q = req.query as Record<string, unknown>;
    const filter = TaskFilter.parse({
      state: csv(q["state"])?.map((s) => TaskStateSchema.parse(s)),
      repo: q["repo"],
      open: bool(q["open"]),
      limit: int(q["limit"]),
    });
    const states =
      filter.state ??
      (filter.open
        ? TaskStateSchema.options.filter((s) => s !== "completed" && s !== "cancelled")
        : undefined);
    return store.listTasks({
      ...(states ? { state: states } : {}),
      ...(filter.repo ? { repo: filter.repo } : {}),
      limit: filter.limit,
    });
  });
  app.get("/v1/tasks/:id", async (req): Promise<TaskDetail> => {
    requireCaller(req);
    const { id } = IdParams.parse(req.params);
    return {
      task: store.requireTask(id),
      runs: store.runs(id),
      events: store.events(id),
      attention: store.listAttention({ taskId: id }),
    };
  });
  app.get("/v1/tasks/:id/progress", async (req): Promise<TaskProgress> => {
    requireCaller(req);
    return supervisor.taskProgress(IdParams.parse(req.params).id);
  });
  // Read-only: any authenticated caller that may inspect tasks may peek, in
  // every task state (manual mode included); it never changes the worker.
  app.get("/v1/tasks/:id/transcript", async (req) => {
    requireCaller(req);
    const { id } = IdParams.parse(req.params);
    const q = req.query as Record<string, unknown>;
    const input = PeekTaskInput.parse({
      limit: int(q["limit"]),
      before: typeof q["before"] === "string" && q["before"] ? q["before"] : undefined,
      reasoningSummaries: bool(q["reasoningSummaries"]),
    });
    return supervisor.peek(id, input);
  });
  app.post("/v1/tasks/:id/send", async (req) => {
    requireCaller(req);
    return supervisor.sendToWorker(
      IdParams.parse(req.params).id,
      SendToWorkerInput.parse(req.body).instructions,
    );
  });
  app.post("/v1/tasks/:id/cancel", async (req) => {
    requireCaller(req);
    if (
      req.actor !== "human" &&
      store.requireTask(IdParams.parse(req.params).id).state === "manual"
    )
      throw forbidden("manual_mode", "The human is driving this task; only they can cancel it");
    return supervisor.cancel(
      IdParams.parse(req.params).id,
      CancelTaskInput.parse(req.body ?? {}).reason,
    );
  });
  app.post("/v1/tasks/:id/cleanup", async (req) => {
    requireCaller(req);
    const { force } = CleanupTaskInput.parse(req.body ?? {});
    return supervisor.cleanup(IdParams.parse(req.params).id, force, req.actor);
  });
  app.post("/v1/tasks/:id/pull-request", async (req) => {
    requireCaller(req);
    const input = OpenPullRequestInput.parse(req.body ?? {});
    return supervisor.openPullRequest(IdParams.parse(req.params).id, input, req.actor);
  });
  app.post("/v1/tasks/:id/merge", async (req) => {
    requireCaller(req);
    const { method } = MergePullRequestInput.parse(req.body ?? {});
    return supervisor.mergePullRequest(IdParams.parse(req.params).id, { method }, req.actor);
  });
  app.get("/v1/tasks/:id/diff", async (req) => {
    requireCaller(req);
    return supervisor.diff(IdParams.parse(req.params).id);
  });
  app.post("/v1/tasks/:id/request-changes", async (req) => {
    requireCaller(req);
    const { feedback } = RequestChangesInput.parse(req.body ?? {});
    return supervisor.requestChanges(IdParams.parse(req.params).id, feedback, req.actor);
  });
  app.get("/v1/tasks/:id/land", async (req) => {
    requireCaller(req);
    return supervisor.landPlan(IdParams.parse(req.params).id);
  });
  app.post("/v1/tasks/:id/land", async (req) => {
    requireCaller(req);
    const input = LandTaskInput.parse(req.body ?? {});
    return supervisor.land(IdParams.parse(req.params).id, input, req.actor);
  });
  app.post("/v1/tasks/:id/discard", async (req) => {
    requireCaller(req);
    const { reason } = DiscardTaskInput.parse(req.body ?? {});
    return supervisor.discard(IdParams.parse(req.params).id, reason, req.actor);
  });
  app.post("/v1/tasks/:id/accept", async (req) => {
    requireCaller(req);
    return supervisor.accept(IdParams.parse(req.params).id, req.actor);
  });
  app.post("/v1/tasks/:id/takeover", async (req) => {
    return supervisor.takeOver(IdParams.parse(req.params).id, req.actor);
  });
  app.post("/v1/tasks/:id/giveback", async (req) => {
    const { mode, note } = GiveBackInput.parse(req.body);
    return supervisor.giveBack(IdParams.parse(req.params).id, mode, note, req.actor);
  });
  app.post("/v1/tasks/:id/resume", async (req) => {
    const { mode } = ResumeTaskInput.parse(req.body);
    return supervisor.resume(IdParams.parse(req.params).id, mode, req.actor);
  });

  // -- attention ---------------------------------------------------------------
  app.get("/v1/attention", async (req) => {
    requireCaller(req);
    const q = req.query as Record<string, unknown>;
    const filter = AttentionFilter.parse({
      status: q["status"],
      taskId: q["taskId"],
      limit: int(q["limit"]),
    });
    return store.listAttention({
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.taskId ? { taskId: filter.taskId } : {}),
      limit: filter.limit,
    });
  });
  app.post("/v1/attention/:id/resolve", async (req) => {
    requireCaller(req);
    const { response } = ResolveAttentionInput.parse(req.body);
    return supervisor.resolveAttention(IdParams.parse(req.params).id, response, req.actor);
  });

  // -- memory and decisions ----------------------------------------------------
  app.post("/v1/memories", async (req) => {
    requireCaller(req);
    return memory.remember(RememberInput.parse(req.body), req.actor);
  });
  app.post("/v1/memories/search", async (req) => {
    requireCaller(req);
    return memory.recall(RecallInput.parse(req.body));
  });
  app.get("/v1/memories", async (req) => {
    requireCaller(req);
    const q = req.query as Record<string, string | undefined>;
    const repo = q["repo"] ? store.requireRepo(q["repo"]) : null;
    return store.listMemories({
      ...(q["status"]
        ? { status: z.enum(["proposed", "confirmed", "retired"]).parse(q["status"]) }
        : {}),
      ...(q["scope"] ? { scope: z.enum(["global", "repo", "task"]).parse(q["scope"]) } : {}),
      ...(repo ? { repoId: repo.id } : {}),
    });
  });
  app.post("/v1/memories/:id/confirm", async (req) =>
    memory.confirm(IdParams.parse(req.params).id, req.actor),
  );
  app.delete("/v1/memories/:id", async (req) => {
    requireCaller(req);
    return { deleted: memory.forget(IdParams.parse(req.params).id, req.actor) };
  });
  app.post("/v1/decisions", async (req) => {
    requireCaller(req);
    return memory.recordDecision(DecisionInput.parse(req.body), req.actor);
  });
  app.get("/v1/decisions", async (req) => {
    requireCaller(req);
    const q = req.query as Record<string, string | undefined>;
    const repo = q["repo"] ? store.requireRepo(q["repo"]) : null;
    return store.listDecisions({
      ...(repo ? { repoId: repo.id } : {}),
      ...(q["taskId"] ? { taskId: q["taskId"] } : {}),
    });
  });

  // -- manager -----------------------------------------------------------------
  app.get("/v1/manager", async (): Promise<ManagerInfo> => ({
    directory: deps.live.managerDirectory,
    active: store.activeManager(),
  }));
  app.get("/v1/briefing", async (req) => {
    requireCaller(req);
    return memory.briefing();
  });

  app.get("/v1/outbox", async (req) => {
    requireCaller(req);
    const q = req.query as Record<string, string | undefined>;
    return store.listOutbox(
      q["status"] ? z.enum(["pending", "delivered", "dead"]).parse(q["status"]) : undefined,
    );
  });

  return app;
}
