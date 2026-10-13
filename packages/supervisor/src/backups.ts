import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { backupDb, type Db } from "./db/index.ts";

const PREFIX = "auto-";

function autoBackups(dir: string): { name: string; mtimeMs: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(".db"))
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
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
  await backupDb(db, target);
  for (const old of autoBackups(dir).slice(keep)) unlinkSync(join(dir, old.name));
  return target;
}
