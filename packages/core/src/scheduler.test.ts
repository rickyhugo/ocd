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

  it("runs a delay longer than 2^31 - 1 ms after 1 ms, as Node does", async () => {
    const s = new FakeScheduler();
    let runs = 0;
    s.setInterval(() => void runs++, 2 ** 31);
    s.setTimeout(() => void runs++, 2 ** 31 - 1);
    await s.advance(3);
    expect(runs).toBe(3);
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
// timers only through an injected `Scheduler`, so tests can drive time
// instead of sleeping. Raw clocks and timers, and the global object they
// hang off, are refused outright. Real time on purpose (`systemScheduler`,
// `AbortSignal.timeout`) is counted per file and must match
// `REAL_TIME_USES`, so each new use is a reviewed edit there.
// `setImmediate` stays allowed, as it does not depend on time. Timeouts a
// platform API takes as an option (`execFile`'s `timeout`) are not seen.
const packages = join(import.meta.dirname, "..", "..");
const GUARDED = ["supervisor", "adapters"].map((name) => join(packages, name, "src"));
const TIMER = "(?:setTimeout|setInterval|clearTimeout|clearInterval)";
const RAW_TIME = new RegExp(
  [
    `(?<![.\\w$])${TIMER}\\b`,
    String.raw`\bglobalThis\b|\bglobal\s*[.[]`,
    `["'\`]${TIMER}["'\`]`,
    String.raw`\bDate\.now\b`,
    String.raw`\bnew\s+Date\b(?!\s*\(\s*[^\s)])`,
    String.raw`(?<!\bnew\s+)(?<![.\w$])Date\s*\(`,
    String.raw`\bperformance\.now\b`,
    String.raw`\bprocess\.(?:hrtime|uptime)\b`,
    String.raw`\bTemporal\.Now\b`,
    String.raw`["'](?:node:)?timers\b`,
    String.raw`\bsystemScheduler\s+as\b`,
  ].join("|"),
);
const REAL_TIME = /\bsystemScheduler\b|\bAbortSignal\.timeout\b/g;

/** Uses of real time per guarded file (the import counts), and why it cannot be the injected scheduler. */
const REAL_TIME_USES: Record<string, [number, string]> = {
  "adapters/src/claude.ts": [3, "default; the fail-fast race on the child's exit at start"],
  "adapters/src/codex.ts": [10, "default; RPC timeouts and the interrupt poll on the app-server"],
  "adapters/src/fake.ts": [5, "fake harness step delays and stamps; no test injects time"],
  "adapters/src/jsonl-process.ts": [2, "grace period before killing a child"],
  "adapters/src/opencode.ts": [3, "fetch timeout and reconnect backoff to the OpenCode server"],
  "adapters/src/testing.ts": [7, "test support: stub OpenCode message stamps"],
  "supervisor/src/config.ts": [2, "default"],
  "supervisor/src/daemon.ts": [3, "default; pre-migrate backup file name"],
  "supervisor/src/db/index.ts": [2, "pre-restore backup file name"],
  "supervisor/src/git.ts": [3, "kill timer on a git child"],
  "supervisor/src/github-cli.ts": [2, "default"],
  "supervisor/src/ids.ts": [2, "time prefix of generated ids"],
  "supervisor/src/lock.ts": [2, "lock file start stamp"],
  "supervisor/src/self-update.ts": [9, "default; kill timer and boot poll on update children"],
  "supervisor/src/testkit.ts": [4, "test support: wait for a running daemon"],
};

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

const name = (file: string) => relative(packages, file).split(sep).join("/");

describe("scheduler seam", () => {
  it("recognizes raw time and leaves scheduler calls alone", () => {
    for (const raw of [
      "const t = setTimeout(fn, 5);",
      "clearInterval(timer);",
      "const later = setTimeout;",
      "const { setInterval: every } = globalThis;",
      "const at = Date.now();",
      "const now = clock ?? Date.now;",
      "stamp(new Date().toISOString());",
      "stamp(new Date);",
      "stamp(Date());",
      "const t = process.hrtime.bigint();",
      "const up = process.uptime();",
      "const t = performance.now();",
      "const t = Temporal.Now.instant();",
      'import { setTimeout as delay } from "node:timers/promises";',
      'import { setTimeout } from "timers";',
      "globalThis.setTimeout(fn, 5);",
      'globalThis["setTimeout"](fn, 5);',
      'const set = globalThis["set" + "Timeout"];',
      "const g = globalThis;",
      "global.setTimeout(fn, 5);",
      'import { systemScheduler as clock } from "@ocd/core";',
    ])
      expect(RAW_TIME.test(raw), raw).toBe(true);
    for (const allowed of [
      "this.scheduler.setTimeout(fn, 5);",
      "scheduler.clearInterval(timer);",
      "new Date(scheduler.now()).toISOString();",
      "new Date(ms)",
      "Date.parse(text)",
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
          RAW_TIME.test(line) ? [`${name(file)}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(leaks).toEqual([]);
  });

  it("uses real time only where REAL_TIME_USES says why", () => {
    const uses = Object.fromEntries(
      GUARDED.flatMap(sources).flatMap((file) => {
        const count = code(file).match(REAL_TIME)?.length ?? 0;
        return count ? [[name(file), count]] : [];
      }),
    );
    const allowed = Object.fromEntries(
      Object.entries(REAL_TIME_USES).map(([file, [count]]) => [file, count]),
    );
    expect(uses).toEqual(allowed);
  });
});
