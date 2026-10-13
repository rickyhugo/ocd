import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
export { schema };

export function defaultMigrationsFolder(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@ocd/supervisor/package.json")), "drizzle");
}

export interface OpenDbOptions {
  readonly?: boolean;
}

export function openDb(path: string, options: OpenDbOptions = {}): Db {
  if (!options.readonly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  });
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  if (!options.readonly) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
  }
  return drizzle({ client: sqlite, schema }) as Db;
}

export interface MigrationStatus {
  applied: number;
  available: number;
  pending: number;
  /** Migrations recorded in the database that this code does not know (it is newer). */
  ahead: number;
  /** True for a database with no OCD tables at all. */
  fresh: boolean;
}

export function migrationStatus(
  db: Db,
  migrationsFolder = defaultMigrationsFolder(),
): MigrationStatus {
  const files = readMigrationFiles({ migrationsFolder });
  const client = db.$client;
  const hasTable = client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const userTables = client
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get() as { n: number };
  if (!hasTable) {
    return {
      applied: 0,
      available: files.length,
      pending: files.length,
      ahead: 0,
      fresh: userTables.n === 0,
    };
  }
  const last = client.prepare("SELECT max(created_at) AS at FROM __drizzle_migrations").get() as {
    at: number | null;
  };
  const pending = files.filter((file) => last.at === null || file.folderMillis > last.at).length;
  const newestKnown = Math.max(0, ...files.map((f) => f.folderMillis));
  const ahead = (
    client
      .prepare("SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at > ?")
      .get(newestKnown) as { n: number }
  ).n;
  return { applied: files.length - pending, available: files.length, pending, ahead, fresh: false };
}

export function applyMigrations(db: Db, migrationsFolder = defaultMigrationsFolder()): void {
  migrate(db, { migrationsFolder });
}

/** SQLite online backup: consistent even while the WAL holds uncheckpointed pages. */
export async function backupDb(db: Db, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination))
    throw new Error(`Refusing to overwrite existing backup ${destination}`);
  await db.$client.backup(destination);
}

export function verifyBackup(path: string): void {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = sqlite.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`Backup failed integrity check: ${String(result)}`);
    const migrations = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!migrations) throw new Error("Backup is not an OCD database (no migration table)");
  } finally {
    sqlite.close();
  }
}

/**
 * Replaces the database with a verified backup. The caller must hold the
 * supervisor lock. The previous database (and its WAL) is kept, never deleted.
 */
export function restoreDb(dbPath: string, backupPath: string): { previous: string | null } {
  verifyBackup(backupPath);
  let previous: string | null = null;
  if (existsSync(dbPath)) {
    // Fold the WAL into the main file before moving it aside.
    const current = new Database(dbPath);
    current.pragma("wal_checkpoint(TRUNCATE)");
    current.close();
    previous = `${dbPath}.pre-restore-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    renameSync(dbPath, previous);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, previous + suffix);
    }
  }
  copyFileSync(backupPath, dbPath);
  return { previous };
}
