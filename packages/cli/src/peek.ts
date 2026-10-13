import { setTimeout as delay } from "node:timers/promises";

import { renderEntry, type TaskTranscript, type TranscriptEntry } from "@ocd/core";

// `ocd task peek --follow`: polls the read-only transcript endpoint and prints
// entries it has not shown yet (or whose tool status/output changed). Polling
// is bounded in cadence, duration and consecutive failures.

export const FOLLOW_LIMITS = {
  minIntervalMs: 1000,
  defaultIntervalMs: 3000,
  maxDurationMs: 30 * 60_000,
  maxConsecutiveErrors: 3,
  /** Entries fetched per poll. */
  pageEntries: 50,
} as const;

/** Task states in which new worker activity can still appear. */
const ACTIVE = new Set(["queued", "starting", "running", "blocked", "manual"]);

export type FollowEnd = "finished" | "unavailable" | "errors" | "timeout" | "aborted";

export interface FollowOptions {
  intervalMs?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  write: (text: string) => void;
  /** NDJSON entries instead of text. */
  json?: boolean;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function signature(entry: TranscriptEntry): string {
  return `${entry.tool?.status ?? ""}:${entry.tool?.output?.length ?? 0}:${entry.text?.length ?? 0}`;
}

export function followInterval(seconds: string | undefined): number {
  if (seconds === undefined) return FOLLOW_LIMITS.defaultIntervalMs;
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms)) throw new Error("--interval takes seconds");
  return Math.max(FOLLOW_LIMITS.minIntervalMs, ms);
}

export async function followTranscript(
  fetch: () => Promise<TaskTranscript>,
  options: FollowOptions,
): Promise<{ end: FollowEnd; detail: string }> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      delay(ms, undefined, signal ? { signal } : {}).catch(() => undefined));
  const interval = Math.max(
    FOLLOW_LIMITS.minIntervalMs,
    options.intervalMs ?? FOLLOW_LIMITS.defaultIntervalMs,
  );
  const deadline =
    now() +
    Math.min(options.maxDurationMs ?? FOLLOW_LIMITS.maxDurationMs, FOLLOW_LIMITS.maxDurationMs);
  const seen = new Map<string, string>();
  let errors = 0;
  let first = true;
  for (;;) {
    if (options.signal?.aborted) return { end: "aborted", detail: "stopped" };
    let t: TaskTranscript | null = null;
    try {
      t = await fetch();
      errors = 0;
    } catch (error) {
      errors += 1;
      const message = (error as Error).message ?? String(error);
      if (errors >= FOLLOW_LIMITS.maxConsecutiveErrors)
        return { end: "errors", detail: `${errors} consecutive failures; last: ${message}` };
      options.write(`(peek failed: ${message}; retrying)`);
    }
    if (t) {
      if (first) {
        if (!options.json) {
          options.write(
            `${t.taskId} [${t.taskState}] ${t.harness}: following ${t.source ?? "nothing"} (untrusted worker output; Ctrl-C to stop)`,
          );
          for (const note of t.notes) options.write(`note: ${note}`);
        }
        first = false;
      }
      if (!t.available) return { end: "unavailable", detail: t.notes.join(" ") };
      const fresh = t.entries.filter((e) => seen.get(e.id) !== signature(e));
      if (seen.size > 0 && t.entries.length > 0 && !seen.has(t.entries[0]!.id) && t.before)
        options.write("(more entries arrived than one poll returns; some may have been skipped)");
      for (const entry of fresh) {
        seen.set(entry.id, signature(entry));
        options.write(options.json ? JSON.stringify(entry) : renderEntry(entry));
      }
      // Bound the dedupe set to what the latest page can contain.
      if (seen.size > FOLLOW_LIMITS.pageEntries * 4) {
        const keep = new Set(t.entries.map((e) => e.id));
        for (const id of seen.keys()) if (!keep.has(id)) seen.delete(id);
      }
      if (!ACTIVE.has(t.taskState)) return { end: "finished", detail: `task is ${t.taskState}` };
    }
    if (now() >= deadline) return { end: "timeout", detail: "follow time limit reached" };
    await sleep(interval, options.signal);
  }
}
