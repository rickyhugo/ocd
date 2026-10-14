import { describe, expect, it } from "vite-plus/test";

import { claudeUsage, codexUsage } from "./usage-limits.ts";

const AT = "2026-10-14T15:00:00.000Z";

describe("usage limits as the harnesses report them", () => {
  it("maps Claude Code's per-window view, and a bare event to the window it names", () => {
    // Recorded from Claude Code 2.1.299.
    const real = claudeUsage(
      {
        status: "allowed",
        resetsAt: 1792003800,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.08, resetsAt: 1792003800 },
          seven_day: { utilization: 0.63, resetsAt: 1792267200 },
          seven_day_opus: { utilization: 0.5 },
        },
      },
      AT,
    );
    expect(real).toMatchObject({ harness: "claude", state: "ok", observedAt: AT });
    expect(real.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5-hour", 8],
      ["weekly", 63],
      ["weekly Opus", 50],
    ]);
    expect(real.windows[2]!.resetsAt).toBeNull();

    const bare = claudeUsage(
      { status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: 1792267200 },
      AT,
    );
    expect(bare).toMatchObject({
      state: "limited",
      windows: [{ id: "seven_day", usedPercent: 100 }],
    });
    expect(claudeUsage({ status: "allowed_warning" }, AT)).toMatchObject({
      state: "warning",
      windows: [],
    });
  });

  it("maps Codex buckets and windows, naming model-specific buckets", () => {
    const usage = codexUsage(
      {
        ordinaryUsageAllowed: true,
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 41.26, windowDurationMins: 300, resetsAt: 1792000000 },
            secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 1792477564 },
            planType: "pro",
          },
          other: {
            limitId: "other",
            limitName: "GPT-6 Sol",
            primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: null },
          },
        },
      },
      AT,
    );
    expect(usage).toMatchObject({ state: "ok", plan: "pro" });
    expect(usage.windows.map((w) => [w.id, w.label, w.short, w.usedPercent])).toEqual([
      ["codex:300", "5-hour", "5h", 41.3],
      ["codex:10080", "weekly", "wk", 22],
      ["other:10080", "GPT-6 Sol weekly", "GPT-6 Sol wk", 5],
    ]);
    expect(
      codexUsage(
        {
          rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: "rate_limit_reached" },
        },
        AT,
      ),
    ).toMatchObject({ state: "limited", windows: [{ id: "codex:window", label: "rolling" }] });
  });
});
