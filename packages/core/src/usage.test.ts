import { describe, expect, it } from "vite-plus/test";

import { usageLines, usageSummary, windowLabels, type HarnessUsage } from "./usage.ts";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

const claude: HarnessUsage = {
  harness: "claude",
  state: "ok",
  plan: null,
  observedAt: at(-5 * 60_000),
  windows: [
    { id: "five_hour", label: "5-hour", short: "5h", usedPercent: 8, resetsAt: at(3_600_000) },
    { id: "seven_day", label: "weekly", short: "wk", usedPercent: 63, resetsAt: at(-60_000) },
  ],
};
const codex: HarnessUsage = {
  harness: "codex",
  state: "ok",
  plan: "pro",
  observedAt: at(0),
  windows: [{ id: "codex:10080", label: "weekly", short: "wk", usedPercent: 84, resetsAt: null }],
};

describe("usage wording", () => {
  it("names windows by length", () => {
    expect(windowLabels(300)).toEqual({ label: "5-hour", short: "5h" });
    expect(windowLabels(10_080)).toEqual({ label: "weekly", short: "wk" });
    expect(windowLabels(4320)).toEqual({ label: "3-day", short: "3d" });
    expect(windowLabels(null)).toBeNull();
  });

  it("describes each harness, and a window that reset since it was seen", () => {
    const [line] = usageLines([claude], NOW);
    expect(line).toMatch(
      /^Claude Code: 5-hour 8% \(resets \d\d:\d\d\) · weekly reset at \d\d:\d\d · seen 5m ago$/,
    );
    expect(usageLines([{ ...codex, state: "limited" }], NOW)[0]).toBe(
      "Codex: LIMIT REACHED · weekly 84% · seen just now",
    );
  });

  it("summarizes for the sidebar, warning from the lowest threshold", () => {
    expect(usageSummary({ harnesses: [claude], notifyAt: [80, 95] }, NOW)).toEqual({
      text: "claude 5h 8% wk ↻",
      tone: "muted",
    });
    expect(usageSummary({ harnesses: [claude, codex], notifyAt: [80, 95] }, NOW)).toEqual({
      text: "claude 5h 8% wk ↻ · codex wk 84%",
      tone: "warning",
    });
    expect(
      usageSummary({ harnesses: [{ ...codex, state: "limited" }], notifyAt: [] }, NOW)?.tone,
    ).toBe("error");
    expect(usageSummary({ harnesses: [], notifyAt: [80] }, NOW)).toBeNull();
  });
});
