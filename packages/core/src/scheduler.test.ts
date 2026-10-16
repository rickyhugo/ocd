import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { FakeScheduler } from "./scheduler.ts";

describe("FakeScheduler", () => {
  it("fires due timers in time order, repeats intervals, and skips cleared ones", async () => {
    const s = new FakeScheduler(1000);
    const fired: string[] = [];
    const record = (name: string) => () => void fired.push(`${name}@${s.now()}`);
    s.setTimeout(record("late"), 30);
    s.setTimeout(record("early"), 10);
    const every = s.setInterval(record("tick"), 20);
    s.clearTimeout(s.setTimeout(record("cleared"), 5));
    s.setTimeout(record("zero"), 0);

    await s.advance(9);
    expect(fired).toEqual(["zero@1001"]);
    await s.advance(41);
    expect(fired).toEqual(["zero@1001", "early@1010", "tick@1020", "late@1030", "tick@1040"]);
    expect(s.now()).toBe(1050);
    expect(s.pending).toBe(1);
    s.clearInterval(every);
    await s.advance(100);
    expect(fired).toHaveLength(5);
    expect(s.pending).toBe(0);
  });

  it("lets a timer's async work settle before the next timer fires", async () => {
    const s = new FakeScheduler();
    const order: string[] = [];
    s.setTimeout(() => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        order.push("first settled");
      })();
    }, 10);
    s.setTimeout(() => void order.push("second fired"), 10);
    await s.advance(10);
    expect(order).toEqual(["first settled", "second fired"]);
  });
});

// The scheduler seam: supervisor and adapter code reads the time and sets
// timers only through a `Scheduler`, so tests can drive time instead of
// sleeping. `systemScheduler` in this file is the one place that may use the
// globals; `setImmediate` stays allowed, as it does not depend on time.
// Timeouts a platform API applies to real I/O (`execFile`'s `timeout`,
// `AbortSignal.timeout` on a fetch) also stay: no scheduler can drive them.
const packages = join(import.meta.dirname, "..", "..");
const GUARDED = ["supervisor", "adapters"].map((name) => join(packages, name, "src"));
const RAW_TIME =
  /(?:(?<![.\w])|globalThis\.)(?:setTimeout|setInterval|clearTimeout|clearInterval)\s*\(|\bDate\.now\b|\bnew Date\(\s*\)|\bperformance\.now\s*\(|["'](?:node:)?timers/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Source without comments (prose may name the globals; code may not), lines kept in place. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("scheduler seam", () => {
  it("recognizes raw time and leaves scheduler calls alone", () => {
    for (const raw of [
      "const t = setTimeout(fn, 5);",
      "clearInterval(timer);",
      "const at = Date.now();",
      "const now = clock ?? Date.now;",
      "stamp(new Date().toISOString());",
      'import { setTimeout as delay } from "node:timers/promises";',
      "globalThis.setTimeout(fn, 5);",
      'import { setTimeout } from "timers";',
    ])
      expect(RAW_TIME.test(raw), raw).toBe(true);
    for (const allowed of [
      "this.scheduler.setTimeout(fn, 5);",
      "scheduler.clearInterval(timer);",
      "new Date(scheduler.now()).toISOString();",
      "new Date(ms)",
      "setImmediate(() => void stop());",
    ])
      expect(RAW_TIME.test(allowed), allowed).toBe(false);
  });

  it("keeps raw timers and clock reads out of supervisor and adapter code", () => {
    const files = GUARDED.flatMap(sources);
    expect(files.length).toBeGreaterThan(30);
    const leaks = files.flatMap((file) =>
      code(file)
        .split("\n")
        .flatMap((line, i) =>
          RAW_TIME.test(line)
            ? [`${relative(packages, file).split(sep).join("/")}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(leaks).toEqual([]);
  });
});
