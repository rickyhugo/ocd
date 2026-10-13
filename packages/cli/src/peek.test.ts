import { textEntry, toolEntry, type TaskTranscript, type TranscriptEntry } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { FOLLOW_LIMITS, followInterval, followTranscript } from "./peek.ts";

function transcript(
  entries: TranscriptEntry[],
  over: Partial<TaskTranscript> = {},
): TaskTranscript {
  return {
    taskId: "t_1",
    harness: "claude",
    sessionId: "s",
    taskState: "running",
    available: true,
    source: "live_buffer",
    notes: [],
    entries,
    before: null,
    truncated: false,
    reasoningSummaries: "unsupported",
    untrusted: true,
    notice: "untrusted",
    generatedAt: "",
    ...over,
  };
}

/** Fake clock: sleeping advances time instantly. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    slept: () => t,
  };
}

const running = (status: "running" | "completed") =>
  toolEntry({
    id: "tool:1",
    at: null,
    name: "Bash",
    callId: "1",
    status,
    input: "npm test",
    output: status === "completed" ? "ok" : null,
  });

describe("ocd task peek --follow", () => {
  it("prints new and changed entries once, and stops when the task finishes", async () => {
    const pages = [
      transcript([textEntry("m1", null, "Starting")]),
      transcript([textEntry("m1", null, "Starting"), running("running")]),
      transcript([textEntry("m1", null, "Starting"), running("completed")]),
      transcript(
        [textEntry("m1", null, "Starting"), running("completed"), textEntry("m2", null, "Done")],
        {
          taskState: "ready_for_review",
        },
      ),
    ];
    const out: string[] = [];
    const c = clock();
    const r = await followTranscript(async () => pages.shift()!, {
      write: (l) => out.push(l),
      now: c.now,
      sleep: c.sleep,
    });
    expect(r).toEqual({ end: "finished", detail: "task is ready_for_review" });
    const body = out.slice(1).join("\n");
    expect(out[0]).toMatch(/following live_buffer \(untrusted/);
    expect(body.match(/Starting/g)).toHaveLength(1);
    expect(body).toContain("tool Bash [running]");
    expect(body).toContain("tool Bash [completed]");
    expect(body).toContain("Done");
    expect(c.slept()).toBe(3 * FOLLOW_LIMITS.defaultIntervalMs);
  });

  it("stops at once when the transcript is unavailable", async () => {
    const r = await followTranscript(
      async () => transcript([], { available: false, source: null, notes: ["memory only"] }),
      { write: () => undefined, ...clock() },
    );
    expect(r).toEqual({ end: "unavailable", detail: "memory only" });
  });

  it("gives up after consecutive errors but survives isolated ones", async () => {
    const out: string[] = [];
    let n = 0;
    const flaky = await followTranscript(
      async () => {
        n += 1;
        if (n === 2) throw new Error("socket closed");
        return transcript([], { taskState: n >= 3 ? "completed" : "running" });
      },
      { write: (l) => out.push(l), ...clock() },
    );
    expect(flaky.end).toBe("finished");
    expect(out.join("\n")).toContain("peek failed: socket closed; retrying");

    const broken = await followTranscript(
      async () => {
        throw new Error("supervisor down");
      },
      { write: () => undefined, ...clock() },
    );
    expect(broken).toEqual({
      end: "errors",
      detail: `${FOLLOW_LIMITS.maxConsecutiveErrors} consecutive failures; last: supervisor down`,
    });
  });

  it("is bounded in time and cadence, and stops when aborted", async () => {
    const c = clock();
    let polls = 0;
    const timed = await followTranscript(
      async () => {
        polls += 1;
        return transcript([]);
      },
      { write: () => undefined, intervalMs: 10, maxDurationMs: 5000, now: c.now, sleep: c.sleep },
    );
    expect(timed.end).toBe("timeout");
    // The interval is raised to the minimum, so 5 s allows at most 6 polls.
    expect(polls).toBeLessThanOrEqual(6);

    const stop = new AbortController();
    const aborted = await followTranscript(
      async () => {
        stop.abort();
        return transcript([]);
      },
      { write: () => undefined, signal: stop.signal, ...clock() },
    );
    expect(aborted.end).toBe("aborted");

    expect(followInterval(undefined)).toBe(FOLLOW_LIMITS.defaultIntervalMs);
    expect(followInterval("0.1")).toBe(FOLLOW_LIMITS.minIntervalMs);
    expect(followInterval("5")).toBe(5000);
    expect(() => followInterval("soon")).toThrow(/seconds/);
  });

  it("prints NDJSON entries in --json mode", async () => {
    const out: string[] = [];
    await followTranscript(
      async () => transcript([textEntry("m1", null, "hi")], { taskState: "completed" }),
      { write: (l) => out.push(l), json: true, ...clock() },
    );
    expect(out.map((l) => JSON.parse(l).id)).toEqual(["m1"]);
  });
});
