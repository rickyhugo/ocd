import { describe, expect, it } from "vite-plus/test";

import {
  TRANSCRIPT_LIMITS,
  clip,
  renderTranscript,
  sanitizeText,
  sanitizeValue,
  textEntry,
  toolEntry,
  type TaskTranscript,
} from "./index.ts";

describe("transcript sanitizing", () => {
  it("clips long text keeping its start and end", () => {
    const text = `start ${"x".repeat(10_000)} end`;
    const out = clip(text, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.startsWith("start")).toBe(true);
    expect(out.endsWith("end")).toBe(true);
    expect(out).toContain("[clipped]");
  });

  it("redacts secrets in text and under secret-looking keys of structured input", () => {
    expect(sanitizeText("key sk-ant-abcdefghijklmnopqrstuv", 100).text).toBe("key [REDACTED]");
    const input = sanitizeValue(
      {
        command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstu'",
        password: "hunter22",
        nested: { apiKey: "zzzzzzzz" },
      },
      1000,
    ).text;
    expect(input).not.toContain("hunter22");
    expect(input).not.toContain("zzzzzzzz");
    expect(input).not.toContain("abcdefghijklmnopqrstu");
    expect(input).toContain('"password":"[REDACTED]"');
  });

  it("never leaks a secret split by a clip boundary", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    // The secret straddles where the 100-char output is cut.
    const text = `${"a ".repeat(24)}${secret}${"b".repeat(5000)}`;
    const { text: out, truncated } = sanitizeText(text, 100);
    expect(truncated).toBe(true);
    expect(out).not.toContain("ghp_");
  });

  it("bounds tool entries and marks clipped content", () => {
    const e = toolEntry({
      id: "t",
      at: null,
      name: "Bash",
      callId: "t",
      status: "completed",
      input: { command: "y".repeat(5000) },
      output: "z".repeat(50_000),
    });
    expect(e.truncated).toBe(true);
    expect(e.tool!.input!.length).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.toolInputChars);
    expect(e.tool!.output!.length).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.toolOutputChars);
  });

  it("renders entries, notes, labels and the paging cursor", () => {
    const t: TaskTranscript = {
      taskId: "t_1",
      harness: "codex",
      sessionId: "thr_1",
      taskState: "running",
      available: true,
      source: "live_buffer",
      notes: ["memory only"],
      entries: [
        textEntry("r", "2026-10-13T00:00:00.000Z", "Looked at tests", "reasoning_summary"),
        toolEntry({
          id: "c",
          at: null,
          name: "shell",
          callId: "c",
          status: "completed",
          input: "npm test",
          output: "ok",
        }),
        textEntry("m", null, "All green"),
      ],
      before: "CURSOR",
      truncated: false,
      reasoningSummaries: "included",
      untrusted: true,
      notice: "untrusted",
      generatedAt: "2026-10-13T00:00:00.000Z",
    };
    const text = renderTranscript(t);
    expect(text).toContain("t_1 [running] codex session thr_1: 3 entries from live_buffer");
    expect(text).toContain("note: memory only");
    expect(text).toContain("reasoning summary (provider-supplied):");
    expect(text).toContain("tool shell [completed]\n  input:\n    npm test\n  output:\n    ok");
    expect(text).toContain("assistant:\n    All green");
    expect(text).toContain("older entries: before=CURSOR");
  });
});
