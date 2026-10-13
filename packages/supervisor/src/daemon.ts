import { chmodSync } from "node:fs";
import { join } from "node:path";

import type { HarnessAdapter } from "@ocd/adapters";
import { resolveOcdPaths, type OcdPaths, type ShutdownReport } from "@ocd/core";
import type { FastifyInstance } from "fastify";

import { buildApi } from "./api.ts";
import {
  ProfileRegistry,
  loadConfig,
  toProfiles,
  type SupervisorConfig,
  type SupervisorConfigInput,
} from "./config.ts";
import { applyMigrations, backupDb, migrationStatus, openDb, type Db } from "./db/index.ts";
import type { SimulatedCrash } from "./errors.ts";
import { ensurePrivateDir, removeStaleSocket } from "./fsutil.ts";
import { newId, systemClock, type Clock } from "./ids.ts";
import { SupervisorLock } from "./lock.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MemoryService } from "./memory.ts";
import { MacNotifier, type ManagerChannel, type Notifier } from "./notify.ts";
import { OutboxWorker } from "./outbox.ts";
import { Store } from "./store.ts";
import { Supervisor, type SupervisorHooks } from "./supervisor.ts";
import { WorkspaceManager } from "./workspace.ts";

export interface DaemonOptions {
  paths?: OcdPaths;
  config?: Partial<SupervisorConfigInput>;
  /** Builds adapters once config is known. */
  adapters: (ctx: {
    config: SupervisorConfig;
    logger: Logger;
  }) => HarnessAdapter[] | Promise<HarnessAdapter[]>;
  /** The channel that wakes the manager, usually provided by the OpenCode adapter. */
  managerChannel?: (adapters: HarnessAdapter[]) => ManagerChannel | null;
  notifier?: Notifier;
  logger?: Logger;
  foreground?: boolean;
  /** Apply pending migrations to an existing database (after a backup). */
  migrate?: boolean;
  clock?: Clock;
  hooks?: SupervisorHooks;
}

export class PendingMigrationsError extends Error {
  constructor(pending: number) {
    super(
      `The OCD database has ${pending} pending migration(s). Run \`ocd db migrate\` (it backs up first).`,
    );
    this.name = "PendingMigrationsError";
  }
}

export interface Daemon {
  readonly paths: OcdPaths;
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly instanceId: string;
  /** Resolves when the daemon has fully stopped. */
  readonly closed: Promise<ShutdownReport | null>;
  stop(): Promise<ShutdownReport>;
  /** Tear down abruptly, as after a crash: no state changes, locks released by closing handles. */
  kill(): Promise<void>;
}

/** Opens the database, creating it on first use and refusing silent upgrades. */
export async function prepareDatabase(
  paths: OcdPaths,
  options: { migrate?: boolean; logger?: Logger } = {},
): Promise<Db> {
  const db = openDb(paths.db);
  const status = migrationStatus(db);
  if (status.pending > 0) {
    if (status.fresh) {
      applyMigrations(db);
    } else if (options.migrate) {
      const backup = join(
        paths.backups,
        `pre-migrate-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.db`,
      );
      await backupDb(db, backup);
      options.logger?.info({ backup }, "backed up database before migrating");
      applyMigrations(db);
    } else {
      db.$client.close();
      throw new PendingMigrationsError(status.pending);
    }
  }
  return db;
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const paths = options.paths ?? resolveOcdPaths();
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(paths.logs);
  ensurePrivateDir(paths.workspaces);
  ensurePrivateDir(paths.backups);

  const config = loadConfig(paths.config, options.config);
  const profiles = new ProfileRegistry(toProfiles(config));
  const instanceId = newId("sup");
  const clock = options.clock ?? systemClock;

  // The lock comes first: before touching logs, the database, the socket, or any worker.
  const lock = SupervisorLock.acquire(paths.lock, { pid: process.pid, instanceId });
  const logger =
    options.logger ??
    createLogger({
      logsDir: paths.logs,
      foreground: options.foreground ?? false,
      maxBytes: config.log.maxBytes,
      keep: config.log.keep,
    });
  let db: Db | null = null;
  let app: FastifyInstance | null = null;
  try {
    db = await prepareDatabase(paths, { migrate: options.migrate ?? false, logger });
    const store = new Store(db, clock);
    const adapters = await options.adapters({ config, logger });
    const workspaces = new WorkspaceManager(paths.workspaces);
    const memory = new MemoryService(store);
    const managerChannel = options.managerChannel?.(adapters) ?? null;
    const outbox = new OutboxWorker(
      store,
      config,
      options.notifier ?? new MacNotifier(),
      managerChannel,
      logger.child({ component: "outbox" }),
    );

    let resolveClosed!: (report: ShutdownReport | null) => void;
    const closed = new Promise<ShutdownReport | null>((resolve) => {
      resolveClosed = resolve;
    });
    let stopping: Promise<ShutdownReport> | null = null;
    let report: ShutdownReport | null = null;
    let crashed = false;

    const release = async () => {
      await app?.close().catch(() => undefined);
      try {
        removeStaleSocket(paths.socket);
      } catch {
        // Leave anything unexpected in place.
      }
      if (db?.$client.open) db.$client.close();
      lock.release();
    };

    const kill = async () => {
      crashed = true;
      supervisor.halt();
      for (const adapter of adapters) {
        // Simulated process death: service-owned sessions live on, owned workers die.
        await adapter.close().catch(() => undefined);
      }
      await release();
      resolveClosed(null);
    };

    const supervisor = new Supervisor({
      store,
      config,
      adapters,
      workspaces,
      memory,
      outbox,
      logger: logger.child({ component: "supervisor" }),
      clock,
      instanceId,
      profiles,
      ...(options.hooks ? { hooks: options.hooks } : {}),
      onCrash: (error: SimulatedCrash) => {
        logger.warn({ point: error.point }, "simulated crash");
        void kill();
      },
    });

    const stop = (): Promise<ShutdownReport> => {
      stopping ??= (async () => {
        if (!crashed) report ??= await supervisor.stop();
        await release();
        resolveClosed(report);
        return (
          report ?? { workerPolicy: "Supervisor crashed; workers were not stopped.", workers: [] }
        );
      })();
      return stopping;
    };

    app = buildApi({
      store,
      supervisor,
      memory,
      workspaces,
      logger,
      profiles,
      reload: () => {
        const next = toProfiles(loadConfig(paths.config, options.config));
        profiles.replace(next);
        logger.info({ profiles: next.map((p) => p.name) }, "profiles reloaded");
        return profiles.list();
      },
      requestShutdown: async () => {
        report ??= await supervisor.stop();
        setImmediate(() => void stop());
        return report;
      },
    });

    // Holding the lock proves any existing socket file is stale.
    removeStaleSocket(paths.socket);
    await app.listen({ path: paths.socket });
    chmodSync(paths.socket, 0o600);
    await supervisor.start();
    logger.info({ socket: paths.socket, instanceId, pid: process.pid }, "supervisor started");

    return { paths, store, supervisor, instanceId, closed, stop, kill };
  } catch (error) {
    await app?.close().catch(() => undefined);
    if (db?.$client.open) db.$client.close();
    lock.release();
    throw error;
  }
}
