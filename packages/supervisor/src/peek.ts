import {
  PeekTaskInput,
  TRANSCRIPT_LIMITS,
  TRANSCRIPT_NOTICE,
  entrySize,
  redact,
  sanitizeEntry,
  truncate,
  type HarnessName,
  type Scheduler,
  type TaskTranscript,
  type Timer,
  type TranscriptEntry,
} from "@ocd/core";
import { InvalidCursorError, type HarnessAdapter, type TranscriptPage } from "@ocd/adapters";
import type { z } from "zod";

import { badRequest } from "./errors.ts";
import type { Store } from "./store.ts";

export const PEEK_TIMEOUT_MS = 10_000;

interface PeekCursor {
  /** Task and session the cursor was issued for. */
  t: string;
  s: string;
  /** The adapter's own cursor. */
  b: string;
}

function encodeCursor(cursor: PeekCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): PeekCursor | null {
  try {
    const c = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<PeekCursor>;
    return typeof c.t === "string" && typeof c.s === "string" && typeof c.b === "string"
      ? { t: c.t, s: c.s, b: c.b }
      : null;
  } catch {
    return null;
  }
}

export interface PeekOptions {
  store: Pick<Store, "requireTask" | "now">;
  adapterFor: (harness: HarnessName) => HarnessAdapter | undefined;
  /** How long a transcript read may take. */
  timeoutMs: () => number;
  scheduler: Scheduler;
}

export class PeekService {
  private readonly o: PeekOptions;

  constructor(o: PeekOptions) {
    this.o = o;
  }

  /**
   * Read-only view of a worker's recent messages and tool activity. Takes no
   * task lock and writes nothing: it never starts, resumes, prompts or
   * releases a worker, so it is safe in every state, including manual mode.
   */
  async peek(taskId: string, input: z.output<typeof PeekTaskInput>): Promise<TaskTranscript> {
    const task = this.o.store.requireTask(taskId);
    const result: TaskTranscript = {
      taskId: task.id,
      harness: task.harness,
      sessionId: task.sessionId,
      taskState: task.state,
      available: false,
      source: null,
      notes: [],
      entries: [],
      before: null,
      truncated: false,
      reasoningSummaries: input.reasoningSummaries ? "unsupported" : "excluded",
      untrusted: true,
      notice: TRANSCRIPT_NOTICE,
      generatedAt: this.o.store.now(),
    };
    const unavailable = (note: string) => ({ ...result, notes: [...result.notes, note] });
    if (!task.sessionId)
      return unavailable(`The task has no worker session yet (it is ${task.state}).`);
    const sessionId = task.sessionId;
    // Cursors are bound to this task's session: one from another task (or an
    // earlier session of this task) is refused rather than read elsewhere.
    let before: string | null = null;
    if (input.before !== undefined) {
      const cursor = decodeCursor(input.before);
      if (!cursor || cursor.t !== task.id || cursor.s !== sessionId)
        throw badRequest("invalid_cursor", "The cursor does not belong to this task's session");
      before = cursor.b;
    }
    const adapter = this.o.adapterFor(task.harness);
    if (!adapter?.transcript || !adapter.capabilities.transcript)
      return unavailable(`The ${task.harness} adapter cannot read worker transcripts.`);
    if (task.state === "manual")
      result.notes.push(
        "The human is driving this session directly (manual mode); OCD only reads it.",
      );
    const timeoutMs = this.o.timeoutMs();
    const read = async (limit: number): Promise<TranscriptPage | null> => {
      const abort = new AbortController();
      let timer: Timer | undefined;
      try {
        return await Promise.race([
          adapter.transcript!(
            { sessionId },
            { limit, before, reasoningSummaries: input.reasoningSummaries, signal: abort.signal },
          ),
          new Promise<never>((_, reject) => {
            timer = this.o.scheduler.setTimeout(() => {
              abort.abort();
              reject(new Error(`timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) this.o.scheduler.clearTimeout(timer);
      }
    };
    // Defense in depth: re-apply redaction and bounds whatever the adapter did.
    const bounded = (page: TranscriptPage) => {
      let entries = page.entries.slice(-input.limit).map(sanitizeEntry);
      let size = entries.reduce((sum, e) => sum + entrySize(e), 0);
      while (entries.length > 1 && size > TRANSCRIPT_LIMITS.responseChars) {
        size -= entrySize(entries[0]!);
        entries = entries.slice(1);
      }
      return entries;
    };
    let page: TranscriptPage | null;
    let entries: TranscriptEntry[] = [];
    try {
      page = await read(input.limit);
      if (page) {
        entries = bounded(page);
        if (entries.length < Math.min(input.limit, page.entries.length)) {
          // Too large for one response: read fewer, so the adapter's cursor
          // continues exactly where this page ends.
          result.notes.push(
            `Only the newest ${entries.length} entries fit in one response (${TRANSCRIPT_LIMITS.responseChars} characters); page back for older ones.`,
          );
          page = await read(entries.length);
          entries = page ? bounded(page) : [];
        }
      }
    } catch (error) {
      if (error instanceof InvalidCursorError) throw badRequest("invalid_cursor", error.message);
      return unavailable(
        `Reading the ${task.harness} transcript failed: ${truncate(redact((error as Error).message ?? String(error)), 300)}`,
      );
    }
    if (!page) {
      return unavailable(
        adapter.sessionsSurviveSupervisor
          ? `The ${task.harness} session ${sessionId} no longer exists in the harness.`
          : `OCD has no record of this ${task.harness} session's activity: it keeps what it observes from workers it runs as processes in memory only, so nothing is available after a supervisor restart, for a session OCD never ran in this process, or once newer sessions have pushed it out. OCD never resumes a session just to read it.`,
      );
    }
    const exact = entries.length === Math.min(input.limit, page.entries.length);
    return {
      ...result,
      available: true,
      source: page.source,
      notes: [...result.notes, ...page.notes],
      entries,
      before:
        page.before !== null && exact
          ? encodeCursor({ t: task.id, s: sessionId, b: page.before })
          : null,
      truncated: page.truncated || !exact,
      reasoningSummaries: page.reasoningSummaries,
    };
  }
}
