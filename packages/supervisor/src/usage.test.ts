import { join } from "node:path";

import type { HarnessUsage } from "@ocd/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createLogger } from "./logger.ts";
import type { OutboxInput } from "./store.ts";
import { rmrf, startHarness, tempDir, waitFor, type Harness } from "./testkit.ts";
import { UsageTracker } from "./usage.ts";

const roots: string[] = [];
let h: Harness | null = null;
afterEach(async () => {
  for (const r of roots.splice(0)) rmrf(r);
  await h?.cleanup();
  h = null;
});

const NOW = Date.parse("2026-10-14T12:00:00Z");
const in1h = new Date(NOW + 3_600_000).toISOString();
const in5d = new Date(NOW + 5 * 86_400_000).toISOString();

function claude(fiveHour: number, weekly = 40, state: HarnessUsage["state"] = "ok"): HarnessUsage {
  return {
    harness: "claude",
    state,
    plan: null,
    observedAt: new Date(NOW).toISOString(),
    windows: [
      { id: "five_hour", label: "5-hour", short: "5h", usedPercent: fiveHour, resetsAt: in1h },
      { id: "seven_day", label: "weekly", short: "wk", usedPercent: weekly, resetsAt: in5d },
    ],
  };
}

function tracker(options: { file?: string; notifyAt?: number[]; now?: () => number } = {}) {
  const root = tempDir("ocd-usage-");
  roots.push(root);
  const sent: OutboxInput[] = [];
  // The outbox ignores a repeated dedupe key, as the real one does.
  const keys = new Set<string>();
  const t = new UsageTracker({
    file: options.file ?? join(root, "usage.json"),
    settings: () => ({ notifyAt: options.notifyAt ?? [80, 95], pollMinutes: 0 }),
    enqueue: (entries) => {
      for (const e of entries) {
        if (keys.has(e.dedupeKey)) continue;
        keys.add(e.dedupeKey);
        sent.push(e);
      }
    },
    readers: [],
    logger: createLogger({ level: "silent" } as never),
    clock: options.now ?? (() => NOW),
  });
  const titles = () => sent.map((e) => (e.payload as { title: string }).title);
  return { t, sent, titles, root };
}

describe("usage limits", () => {
  it("notifies once per threshold per window, with the percentage and reset time", () => {
    const { t, sent, titles } = tracker();
    t.observe(claude(50));
    expect(sent).toEqual([]);
    t.observe(claude(82));
    expect(titles()).toEqual(["OCD: Claude usage at 82%"]);
    expect((sent[0]!.payload as { body: string }).body).toMatch(
      /^You've used 82% of your 5-hour limit · resets \d\d:\d\d$/,
    );
    // Still above 80: nothing new until the next threshold.
    t.observe(claude(88));
    expect(sent).toHaveLength(1);
    t.observe(claude(97));
    expect(titles()).toEqual(["OCD: Claude usage at 82%", "OCD: Claude usage at 97%"]);
    // Jumping straight past both sends one, for the highest.
    const other = tracker();
    other.t.observe(claude(10, 96));
    expect(other.titles()).toEqual(["OCD: Claude usage at 96%"]);
  });

  it("alerts again in the next window, and says when a limit is reached", () => {
    let now = NOW;
    const { t, titles } = tracker({ now: () => now });
    t.observe(claude(85));
    now += 2 * 3_600_000; // the 5-hour window reset
    const next = claude(81);
    next.windows[0]!.resetsAt = new Date(now + 3 * 3_600_000).toISOString();
    t.observe(next);
    expect(titles()).toEqual(["OCD: Claude usage at 85%", "OCD: Claude usage at 81%"]);
    t.observe({ ...claude(100), state: "limited" });
    expect(titles().at(-1)).toBe("OCD: Claude usage limit reached");
  });

  it("notifies only when a limit is reached with notifyAt empty", () => {
    const { t, titles } = tracker({ notifyAt: [] });
    t.observe(claude(99));
    expect(titles()).toEqual([]);
    t.observe(claude(100, 40, "limited"));
    expect(titles()).toEqual(["OCD: Claude usage limit reached"]);
  });

  it("keeps windows a report leaves out until they reset, and survives a restart", () => {
    const { t, root } = tracker();
    t.observe(claude(30, 63));
    t.observe({ ...claude(31), windows: [claude(31).windows[0]!] });
    expect(t.status().harnesses[0]!.windows.map((w) => w.usedPercent)).toEqual([31, 63]);
    const again = tracker({ file: join(root, "usage.json") });
    expect(again.t.status()).toMatchObject({
      notifyAt: [80, 95],
      harnesses: [{ harness: "claude", windows: [{ usedPercent: 31 }, { usedPercent: 63 }] }],
    });
  });
});

describe("usage limits through the supervisor", () => {
  it("records what a harness reports, notifies, and shows it in status, usage and the briefing", async () => {
    h = await startHarness();
    const usage = { ...claude(83, 63), observedAt: new Date().toISOString() };
    usage.windows[0]!.resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    usage.windows[1]!.resetsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    h.fakeState.emit({ type: "limits", usage });

    const sent = await waitFor(
      () => h!.notifier.sent,
      (s) => s.length > 0,
    );
    expect(sent[0]!.title).toBe("OCD: Claude usage at 83%");
    expect(await h.human.usage()).toMatchObject({
      notifyAt: [80, 95],
      harnesses: [{ harness: "claude", windows: [{ usedPercent: 83 }, { usedPercent: 63 }] }],
    });
    expect((await h.human.status()).usage?.harnesses).toHaveLength(1);
    const briefing = await h.manager("mgr-1").briefing();
    expect(briefing.text).toContain("### Subscription usage limits");
    expect(briefing.text).toMatch(/Claude Code: 5-hour 83% \(resets \d\d:\d\d\) · weekly 63%/);
  });
});
