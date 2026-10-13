import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { autoBackupDue, runAutoBackup } from "./backups.ts";
import { verifyBackup } from "./db/index.ts";
import { startHarness, type Harness } from "./testkit.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe("automatic backups", () => {
  it("writes verifiable backups and keeps only the newest automatic ones", async () => {
    h = await startHarness();
    const dir = h.paths.backups;
    writeFileSync(join(dir, "manual.db"), "not ours");
    const start = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 4; i += 1) await runAutoBackup(h.daemon.store.db, dir, 2, start + i * 1000);
    const autos = readdirSync(dir)
      .filter((n) => n.startsWith("auto-"))
      .sort();
    expect(autos).toHaveLength(2);
    expect(existsSync(join(dir, "manual.db"))).toBe(true);
    verifyBackup(join(dir, autos.at(-1)!));
    expect(autoBackupDue(dir, 3_600_000, Date.now())).toBe(false);
    expect(autoBackupDue(dir, 3_600_000, Date.now() + 2 * 3_600_000)).toBe(true);
  });

  it("backs up at startup when one is due", async () => {
    h = await startHarness({ config: { backups: { intervalHours: 24, keep: 3 } } });
    expect(readdirSync(h.paths.backups).filter((n) => n.startsWith("auto-"))).toHaveLength(1);
  });
});
