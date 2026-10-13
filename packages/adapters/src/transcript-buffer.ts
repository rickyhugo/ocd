import { TRANSCRIPT_LIMITS, entrySize, type TranscriptEntry } from "@ocd/core";

import { InvalidCursorError, type TranscriptPage, type TranscriptRequest } from "./types.ts";

// Bounded, in-memory record of what a process-owned worker (Claude Code,
// Codex) visibly did, built from events the adapter already receives. It is
// not persisted: it does not survive a supervisor restart, and released
// sessions are kept only until newer ones push them out.

export interface TranscriptBufferLimits {
  /** Entries kept per session. */
  maxEntries: number;
  /** Characters of entry content kept per session. */
  maxChars: number;
  /** Sessions kept per adapter; released sessions are evicted first, oldest first. */
  maxSessions: number;
}

export const DEFAULT_BUFFER_LIMITS: TranscriptBufferLimits = {
  maxEntries: 300,
  maxChars: 200_000,
  maxSessions: 32,
};

interface Slot {
  seq: number;
  entry: TranscriptEntry;
  size: number;
}

export class TranscriptBuffer {
  private readonly slots = new Map<string, Slot>();
  private readonly limits: TranscriptBufferLimits;
  private nextSeq = 1;
  private chars = 0;
  /** Entries evicted to stay within bounds. */
  dropped = 0;

  constructor(limits: TranscriptBufferLimits) {
    this.limits = limits;
  }

  get size(): number {
    return this.slots.size;
  }

  get(id: string): TranscriptEntry | undefined {
    return this.slots.get(id)?.entry;
  }

  /**
   * Adds an entry, or replaces the one with the same id in place (a tool call
   * that finished, an event delivered twice), then evicts the oldest entries
   * beyond the bounds. Entries must already be sanitized.
   */
  upsert(entry: TranscriptEntry): void {
    const size = entrySize(entry) + 64;
    const existing = this.slots.get(entry.id);
    if (existing) {
      this.chars += size - existing.size;
      existing.entry = entry;
      existing.size = size;
    } else {
      this.slots.set(entry.id, { seq: this.nextSeq++, entry, size });
      this.chars += size;
    }
    for (const [id, slot] of this.slots) {
      if (this.slots.size <= this.limits.maxEntries && this.chars <= this.limits.maxChars) break;
      if (id === entry.id && this.slots.size === 1) break;
      this.slots.delete(id);
      this.chars -= slot.size;
      this.dropped += 1;
    }
  }

  page(request: Pick<TranscriptRequest, "limit" | "before" | "reasoningSummaries">): {
    entries: TranscriptEntry[];
    before: string | null;
    truncated: boolean;
  } {
    let before = Number.POSITIVE_INFINITY;
    if (request.before !== null) {
      before = Number(request.before);
      if (!Number.isSafeInteger(before) || before < 1 || before > this.nextSeq)
        throw new InvalidCursorError();
    }
    const eligible = [...this.slots.values()].filter(
      (s) => s.seq < before && (request.reasoningSummaries || s.entry.kind !== "reasoning_summary"),
    );
    const page = eligible.slice(-Math.min(request.limit, TRANSCRIPT_LIMITS.maxEntries));
    const older = eligible.length > page.length;
    return {
      entries: page.map((s) => s.entry),
      before: older && page[0] ? String(page[0].seq) : null,
      truncated: !older && this.dropped > 0,
    };
  }
}

/** Per-adapter buffers keyed by session id, bounded in number. */
export class TranscriptStore {
  private readonly buffers = new Map<string, { buffer: TranscriptBuffer; released: boolean }>();
  readonly limits: TranscriptBufferLimits;

  constructor(limits: Partial<TranscriptBufferLimits> = {}) {
    this.limits = { ...DEFAULT_BUFFER_LIMITS, ...limits };
  }

  /** The live buffer for a session the adapter is driving (created on first use). */
  live(sessionId: string): TranscriptBuffer {
    let slot = this.buffers.get(sessionId);
    if (slot) {
      slot.released = false;
      // Most recently used last.
      this.buffers.delete(sessionId);
    } else {
      slot = { buffer: new TranscriptBuffer(this.limits), released: false };
    }
    this.buffers.set(sessionId, slot);
    this.evict();
    return slot.buffer;
  }

  /** The worker process is gone; keep what was seen while room allows. */
  release(sessionId: string): void {
    const slot = this.buffers.get(sessionId);
    if (slot) slot.released = true;
    this.evict();
  }

  read(
    sessionId: string,
    request: TranscriptRequest,
    summaries: "supported" | "unsupported",
  ): TranscriptPage | null {
    const slot = this.buffers.get(sessionId);
    if (!slot) return null;
    const page = slot.buffer.page({
      ...request,
      reasoningSummaries: summaries === "supported" && request.reasoningSummaries,
    });
    return {
      source: slot.released ? "retained_buffer" : "live_buffer",
      ...page,
      reasoningSummaries:
        summaries === "unsupported"
          ? "unsupported"
          : request.reasoningSummaries
            ? "included"
            : "excluded",
      notes: [
        `OCD keeps the last ${this.limits.maxEntries} entries it observed from this worker in memory only; they are lost when the supervisor restarts.`,
        ...(slot.released
          ? [
              "The worker process was released; this is what OCD saw before that. Anything done in the session since (e.g. in manual mode) is not included.",
            ]
          : []),
      ],
    };
  }

  clear(): void {
    this.buffers.clear();
  }

  get sessions(): number {
    return this.buffers.size;
  }

  private evict(): void {
    if (this.buffers.size <= this.limits.maxSessions) return;
    for (const [id, slot] of this.buffers) {
      if (this.buffers.size <= this.limits.maxSessions) return;
      if (slot.released) this.buffers.delete(id);
    }
    // Only live sessions left: drop the least recently used.
    for (const id of this.buffers.keys()) {
      if (this.buffers.size <= this.limits.maxSessions) return;
      this.buffers.delete(id);
    }
  }
}
