import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { DatabaseTooNewError, prepareDatabase } from "./daemon.ts";
import { defaultMigrationsFolder, migrationStatus } from "./db/index.ts";
import { rmrf, tempDir, testPaths } from "./testkit.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rmrf));

/** A copy of the migrations folder truncated to the first `count` entries, plus optional extras. */
function migrationsFolder(count: number, extra: { tag: string; sql: string }[] = []): string {
  const dir = tempDir();
  dirs.push(dir);
  cpSync(defaultMigrationsFolder(), dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string; version: string; breakpoints: boolean }[];
  };
  journal.entries = journal.entries.slice(0, count);
  for (const [n, m] of extra.entries()) {
    journal.entries.push({
      idx: count + n,
      version: "6",
      when: Date.now() + n,
      tag: m.tag,
      breakpoints: true,
    });
    writeFileSync(join(dir, `${m.tag}.sql`), m.sql);
  }
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

function home() {
  const root = tempDir();
  dirs.push(root);
  return testPaths(join(root, "home"));
}

describe("automatic migrations", () => {
  it("upgrades an existing database after backing it up, keeping its data", async () => {
    const paths = home();
    const old = await prepareDatabase(paths, { migrationsFolder: migrationsFolder(2) });
    old.$client.prepare("INSERT INTO settings (key, value) VALUES ('paused', 'true')").run();
    old.$client.close();

    const db = await prepareDatabase(paths);
    expect(migrationStatus(db).pending).toBe(0);
    expect(db.$client.prepare("SELECT value FROM settings WHERE key = 'paused'").get()).toEqual({
      value: "true",
    });
    db.$client.close();
    expect(readdirSync(paths.backups).filter((f) => f.startsWith("pre-migrate-"))).toHaveLength(1);
  });

  it("creates a fresh database without a backup", async () => {
    const paths = home();
    (await prepareDatabase(paths)).$client.close();
    expect(existsSync(paths.backups) ? readdirSync(paths.backups) : []).toEqual([]);
  });

  it("refuses a database migrated by a newer OCD", async () => {
    const paths = home();
    (await prepareDatabase(paths)).$client.close();
    await expect(
      prepareDatabase(paths, { migrationsFolder: migrationsFolder(2) }),
    ).rejects.toBeInstanceOf(DatabaseTooNewError);
  });

  it("rolls back every pending migration when one fails", async () => {
    const paths = home();
    (await prepareDatabase(paths, { migrationsFolder: migrationsFolder(2) })).$client.close();
    const broken = migrationsFolder(2, [
      { tag: "0090_ok", sql: "CREATE TABLE `probe_ok` (`a` text);" },
      {
        tag: "0091_bad",
        sql: "CREATE TABLE `probe_bad` (`a` text);--> statement-breakpoint\nINSERT INTO `no_such_table` VALUES (1);",
      },
    ]);
    await expect(prepareDatabase(paths, { migrationsFolder: broken })).rejects.toThrow(
      /no_such_table/,
    );
    const db = await prepareDatabase(paths, { migrationsFolder: migrationsFolder(2) });
    const tables = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'probe_%'")
      .all();
    db.$client.close();
    expect(tables).toEqual([]);
  });
});
