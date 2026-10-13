import { textEntry, toolEntry } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { TranscriptBuffer, TranscriptStore } from "./transcript-buffer.ts";
import { InvalidCursorError, type TranscriptRequest } from "./types.ts";

const at = "2026-10-13T00:00:00.000Z";
const req = (over: Partial<TranscriptRequest> = {}): TranscriptRequest => ({
  limit: 10,
  before: null,
  reasoningSummaries: false,
  ...over,
});

describe("transcript buffer", () => {
  it("keeps order, replaces entries with the same id in place, and pages backwards", () => {
    const b = new TranscriptBuffer({ maxEntries: 100, maxChars: 100_000, maxSessions: 4 });
    b.upsert(textEntry("m1", at, "one"));
    b.upsert(
      toolEntry({
        id: "t1",
        at,
        name: "Bash",
        callId: "t1",
        status: "running",
        input: { command: "ls" },
      }),
    );
    b.upsert(textEntry("m2", at, "two"));
    // Duplicate delivery and a tool result: same ids, same positions.
    b.upsert(textEntry("m1", at, "one"));
    b.upsert(
      toolEntry({
        id: "t1",
        at,
        name: "Bash",
        callId: "t1",
        status: "completed",
        input: { command: "ls" },
        output: "a\nb",
      }),
    );
    expect(b.size).toBe(3);
    const all = b.page(req());
    expect(all.entries.map((e) => e.id)).toEqual(["m1", "t1", "m2"]);
    expect(all.entries[1]!.tool).toMatchObject({
      status: "completed",
      output: "a\nb",
      input: '{"command":"ls"}',
    });
    expect(all.before).toBeNull();

    const latest = b.page(req({ limit: 2 }));
    expect(latest.entries.map((e) => e.id)).toEqual(["t1", "m2"]);
    const older = b.page(req({ limit: 2, before: latest.before }));
    expect(older.entries.map((e) => e.id)).toEqual(["m1"]);
    expect(older.before).toBeNull();
    expect(() => b.page(req({ before: "nope" }))).toThrow(InvalidCursorError);
    expect(() => b.page(req({ before: "999" }))).toThrow(InvalidCursorError);
  });

  it("bounds entries by count and by characters, and says older ones were dropped", () => {
    const byCount = new TranscriptBuffer({ maxEntries: 3, maxChars: 1_000_000, maxSessions: 4 });
    for (let i = 0; i < 10; i++) byCount.upsert(textEntry(`m${i}`, at, `text ${i}`));
    const page = byCount.page(req());
    expect(page.entries.map((e) => e.id)).toEqual(["m7", "m8", "m9"]);
    expect(page.truncated).toBe(true);
    expect(byCount.dropped).toBe(7);

    const byChars = new TranscriptBuffer({ maxEntries: 1000, maxChars: 3000, maxSessions: 4 });
    for (let i = 0; i < 10; i++) byChars.upsert(textEntry(`m${i}`, at, "x".repeat(1000)));
    expect(byChars.size).toBeLessThanOrEqual(3);
    expect(byChars.page(req()).entries.at(-1)!.id).toBe("m9");
  });

  it("filters reasoning summaries unless requested", () => {
    const b = new TranscriptBuffer({ maxEntries: 10, maxChars: 10_000, maxSessions: 4 });
    b.upsert(textEntry("r1", at, "Checked the parser", "reasoning_summary"));
    b.upsert(textEntry("m1", at, "Done"));
    expect(b.page(req()).entries.map((e) => e.id)).toEqual(["m1"]);
    expect(b.page(req({ reasoningSummaries: true })).entries.map((e) => e.id)).toEqual([
      "r1",
      "m1",
    ]);
  });
});

describe("transcript store", () => {
  it("isolates sessions, marks released ones, and evicts released sessions first", () => {
    const store = new TranscriptStore({ maxSessions: 2 });
    store.live("a").upsert(textEntry("a1", at, "from a"));
    store.live("b").upsert(textEntry("b1", at, "from b"));
    expect(store.read("a", req(), "unsupported")!.entries.map((e) => e.id)).toEqual(["a1"]);
    expect(store.read("b", req(), "unsupported")!.source).toBe("live_buffer");
    expect(store.read("x", req(), "unsupported")).toBeNull();

    store.release("b");
    const retained = store.read("b", req(), "unsupported")!;
    expect(retained.source).toBe("retained_buffer");
    expect(retained.notes.join(" ")).toMatch(/released/);

    // A third session pushes out the released one, not the live one.
    store.live("c");
    expect(store.sessions).toBe(2);
    expect(store.read("b", req(), "unsupported")).toBeNull();
    expect(store.read("a", req(), "unsupported")).not.toBeNull();
    store.clear();
    expect(store.sessions).toBe(0);
  });

  it("labels reasoning summaries per harness support and request", () => {
    const store = new TranscriptStore();
    store.live("s").upsert(textEntry("r", at, "summary", "reasoning_summary"));
    expect(store.read("s", req(), "unsupported")!.reasoningSummaries).toBe("unsupported");
    expect(store.read("s", req({ reasoningSummaries: true }), "unsupported")!.entries).toEqual([]);
    expect(store.read("s", req(), "supported")!.reasoningSummaries).toBe("excluded");
    const included = store.read("s", req({ reasoningSummaries: true }), "supported")!;
    expect(included.reasoningSummaries).toBe("included");
    expect(included.entries[0]!.kind).toBe("reasoning_summary");
  });
});
