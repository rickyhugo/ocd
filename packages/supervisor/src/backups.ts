import { readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { backupDb, verifyBackup, type Db } from "./db/index.ts";

const PREFIX = "auto-";

const PRE_MIGRATE_PREFIX = "pre-migrate-";
const PARTIAL_SUFFIX = ".partial";

function backupsWith(prefix: string, dir: string): { name: string; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

const autoBackups = (dir: string) => backupsWith(PREFIX, dir);

/** Opening a WAL-mode backup, even read-only, can leave empty -wal/-shm files beside it. */
function removeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch {
      // Not there.
    }
  }
}

/**
 * Writes the backup under a temporary name, verifies it, and only then renames
 * it into place, so a crash never leaves a partial file that looks like a backup.
 */
export async function writeVerifiedBackup(db: Db, target: string): Promise<void> {
  const partial = `${target}${PARTIAL_SUFFIX}`;
  try {
    await backupDb(db, partial);
    verifyBackup(partial);
    removeSidecars(partial);
    renameSync(partial, target);
  } catch (error) {
    removeSidecars(partial);
    try {
      unlinkSync(partial);
    } catch {
      // Nothing was written.
    }
    throw error;
  }
}

/** Keeps the newest `keep` pre-migration backups; only files this code created are deleted. */
export function prunePreMigrateBackups(dir: string, keep: number): void {
  for (const old of backupsWith(PRE_MIGRATE_PREFIX, dir).slice(keep))
    unlinkSync(join(dir, old.name));
}

/** Whether the newest automatic backup is older than the interval. */
export function autoBackupDue(dir: string, intervalMs: number, now: number): boolean {
  const newest = autoBackups(dir)[0];
  return !newest || now - newest.mtimeMs >= intervalMs;
}

/**
 * Takes an online SQLite backup and keeps the newest `keep` automatic backups.
 * Only files this function created (auto-*.db) are ever deleted.
 */
export async function runAutoBackup(
  db: Db,
  dir: string,
  keep: number,
  now: number,
): Promise<string> {
  const target = join(dir, `${PREFIX}${new Date(now).toISOString().replaceAll(/[:.]/g, "-")}.db`);
  // A crash can leave an unverified temporary file behind; it never counts as a backup.
  try {
    for (const name of readdirSync(dir))
      if (name.startsWith(PREFIX) && name.endsWith(PARTIAL_SUFFIX)) unlinkSync(join(dir, name));
  } catch {
    // The directory may not exist yet.
  }
  await writeVerifiedBackup(db, target);
  for (const old of autoBackups(dir).slice(keep)) unlinkSync(join(dir, old.name));
  return target;
}
