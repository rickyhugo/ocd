import { chmodSync, writeFileSync } from "node:fs";

import Database from "better-sqlite3";

export class LockHeldError extends Error {
  constructor(path: string) {
    super(`Another OCD supervisor holds ${path}. Only one daemon may own the state directory.`);
    this.name = "LockHeldError";
  }
}

/**
 * Singleton lock held by the OS for the life of the process. SQLite's exclusive
 * locking mode keeps an fcntl lock on the file until the connection closes, and
 * the kernel releases it if the process dies, so no stale PID file can block us.
 */
export class SupervisorLock {
  private readonly db: Database.Database;
  readonly path: string;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
  }

  static acquire(path: string, owner: { pid: number; instanceId: string }): SupervisorLock {
    const db = new Database(path, { timeout: 0 });
    try {
      db.pragma("journal_mode = DELETE");
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER, instance_id TEXT, started_at TEXT)");
      db.exec("COMMIT");
      chmodSync(path, 0o600);
    } catch (error) {
      db.close();
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY"))
        throw new LockHeldError(path);
      throw error;
    }
    // Informational only; ownership is proven by the lock, never by this file.
    writeFileSync(
      `${path}.owner`,
      JSON.stringify({ ...owner, startedAt: new Date().toISOString() }),
      {
        mode: 0o600,
      },
    );
    return new SupervisorLock(db, path);
  }

  release(): void {
    if (this.db.open) this.db.close();
  }
}
