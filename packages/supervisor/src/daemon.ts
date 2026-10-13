import { chmodSync } from "node:fs";
import { join } from "node:path";

import type { HarnessAdapter } from "@ocd/adapters";
import { resolveOcdPaths, type OcdPaths, type ShutdownReport } from "@ocd/core";
import type { FastifyInstance } from "fastify";

import { buildApi } from "./api.ts";
import { autoBackupDue, runAutoBackup } from "./backups.ts";
import {
  ConfigError,
  ConfigWatcher,
  LiveConfig,
  loadConfig,
  normalizeDirectory,
  type SupervisorConfig,
  type SupervisorConfigInput,
} from "./config.ts";
import {
  applyMigrations,
  backupDb,
  defaultMigrationsFolder,
  migrationStatus,
  openDb,
  type Db,
} from "./db/index.ts";
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
  clock?: Clock;
  hooks?: SupervisorHooks;
}

const CONFIG_INVALID_KEY = "config-invalid";

/** Validates declared repository paths: `~` expanded, symlinks resolved, a git root, no duplicates. */
export async function resolveRepos(
  config: SupervisorConfig,
  workspaces: WorkspaceManager,
): Promise<
  { name: string; path: string; defaultProfile: string | null; baseRef: string | null }[]
> {
  const repos = [];
  const seen = new Map<string, string>();
  for (const [name, repo] of Object.entries(config.repos)) {
    let path: string;
    try {
      path = await workspaces.canonicalRepoPath(normalizeDirectory(repo.path));
    } catch (error) {
      throw new ConfigError(`repos.${name}.path: ${(error as Error).message}`);
    }
    const other = seen.get(path);
    if (other) throw new ConfigError(`repos.${name}.path: ${path} is already declared as ${other}`);
    seen.set(path, name);
    repos.push({ name, path, defaultProfile: repo.profile ?? null, baseRef: repo.baseRef ?? null });
  }
  return repos;
}

export class DatabaseTooNewError extends Error {
  constructor(ahead: number) {
    super(
      `The OCD database has ${ahead} migration(s) from a newer OCD version. Update OCD, or restore an older backup from ~/.ocd/backups.`,
    );
    this.name = "DatabaseTooNewError";
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
  /** Re-reads ocd.jsonc now (the file watcher does this on save). */
  reload(): Promise<void>;
}

/** Opens the database, creating it on first use and refusing silent upgrades. */
/**
 * Opens the database and applies pending reviewed migrations. An existing
 * database is backed up first; all pending migrations run in one transaction,
 * so a failure leaves it unchanged. A database newer than this code is refused.
 */
export async function prepareDatabase(
  paths: OcdPaths,
  options: { logger?: Logger; migrationsFolder?: string } = {},
): Promise<Db> {
  const folder = options.migrationsFolder ?? defaultMigrationsFolder();
  const db = openDb(paths.db);
  try {
    const status = migrationStatus(db, folder);
    if (status.ahead > 0) throw new DatabaseTooNewError(status.ahead);
    if (status.pending > 0) {
      if (!status.fresh) {
        const backup = join(
          paths.backups,
          `pre-migrate-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.db`,
        );
        await backupDb(db, backup);
        options.logger?.info({ backup }, "backed up database before migrating");
      }
      applyMigrations(db, folder);
      options.logger?.info(
        { applied: status.pending, total: status.available },
        "applied database migrations",
      );
    }
    return db;
  } catch (error) {
    db.$client.close();
    throw error;
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const paths = options.paths ?? resolveOcdPaths();
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(paths.logs);
  ensurePrivateDir(paths.workspaces);
  ensurePrivateDir(paths.backups);

  const config = loadConfig(paths.config, options.config);
  const live = new LiveConfig(config);
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
    db = await prepareDatabase(paths, { logger });
    const store = new Store(db, clock);
    const adapters = await options.adapters({ config, logger });
    const workspaces = new WorkspaceManager(paths.workspaces);
    store.syncRepos(await resolveRepos(config, workspaces));
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

    // Saved changes to ocd.jsonc apply to profiles immediately. An invalid file
    // keeps the last good profiles and raises one inbox item until it is fixed.
    // Saved changes to ocd.jsonc apply immediately. An invalid file keeps the
    // last good configuration and raises one inbox item until it is fixed.
    const reloadConfig = async () => {
      try {
        const next = loadConfig(paths.config, options.config);
        const repos = await resolveRepos(next, workspaces);
        live.apply(next);
        store.syncRepos(repos);
        // A manager session outside a changed manager directory stops receiving updates.
        const active = store.activeManager();
        if (active && active.directory !== live.managerDirectory) store.retireManager();
        store.settleOpenAttention(CONFIG_INVALID_KEY, "resolved");
        logger.info(
          {
            profiles: live.listProfiles().map((p) => p.name),
            repos: repos.map((r) => r.name),
            managerDirectory: live.managerDirectory,
          },
          "reloaded ocd.jsonc",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, "ocd.jsonc is invalid; keeping the previous configuration");
        const reason = `ocd.jsonc is invalid, so the previous configuration stays in effect. ${message}`;
        const { attention, created } = store.raiseAttention(
          {
            taskId: null,
            kind: "failure",
            dedupeKey: CONFIG_INVALID_KEY,
            reason,
            resolvableBy: "human",
          },
          { notify: true, wake: false },
        );
        // One open item per broken file, always describing the current error.
        if (!created && attention.reason !== reason)
          store.updateAttentionReason(attention.id, reason);
      }
    };
    let backupTimer: NodeJS.Timeout | null = null;
    const configWatcher = new ConfigWatcher(paths.config, () => void reloadConfig());
    // The config just loaded cleanly, so any earlier "invalid config" item is stale.
    store.settleOpenAttention(CONFIG_INVALID_KEY, "resolved");

    const release = async () => {
      configWatcher.stop();
      if (backupTimer) clearInterval(backupTimer);
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
      live,
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
      logger,
      live,

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
    configWatcher.start();

    // Automatic online backups: checked at startup and hourly.
    const backupCheck = async () => {
      const intervalMs = config.backups.intervalHours * 3_600_000;
      if (
        intervalMs <= 0 ||
        !db?.$client.open ||
        !autoBackupDue(paths.backups, intervalMs, clock())
      )
        return;
      try {
        const file = await runAutoBackup(db, paths.backups, config.backups.keep, clock());
        logger.info({ file }, "automatic backup written");
      } catch (error) {
        logger.error({ err: error }, "automatic backup failed");
      }
    };
    await backupCheck();
    backupTimer = setInterval(() => void backupCheck(), 3_600_000);
    backupTimer.unref();
    logger.info({ socket: paths.socket, instanceId, pid: process.pid }, "supervisor started");

    return { paths, store, supervisor, instanceId, closed, stop, kill, reload: reloadConfig };
  } catch (error) {
    await app?.close().catch(() => undefined);
    if (db?.$client.open) db.$client.close();
    lock.release();
    throw error;
  }
}
