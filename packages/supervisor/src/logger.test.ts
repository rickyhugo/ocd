import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createLogger } from "./logger.ts";

describe("logger rotation", () => {
  it("rotates while running, keeps the newest files and loses no line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-log-"));
    const logger = createLogger({ logsDir: dir, maxBytes: 2_000, keep: 3 });
    for (let i = 0; i < 100; i += 1) logger.info({ i }, "x".repeat(40));

    expect(readdirSync(dir).sort()).toEqual([
      "supervisor.log",
      "supervisor.log.1",
      "supervisor.log.2",
      "supervisor.log.3",
    ]);
    expect(existsSync(join(dir, "supervisor.log.4"))).toBe(false);
    // Every kept line is whole JSON and the sequence is contiguous up to the last line.
    const seen = [
      "supervisor.log.3",
      "supervisor.log.2",
      "supervisor.log.1",
      "supervisor.log",
    ].flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { i: number }).i),
    );
    expect(seen.at(-1)).toBe(99);
    expect(seen).toEqual(seen.map((_, k) => seen[0]! + k));
  });
});
