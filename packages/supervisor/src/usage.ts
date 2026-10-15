import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { HARNESSES, labelOf } from "@ocd/adapters";
import {
  resetTime,
  windowReset,
  type HarnessName,
  type HarnessUsage,
  type UsageStatus,
  type UsageWindow,
} from "@ocd/core";

import type { Clock } from "./ids.ts";
import type { Logger } from "./logger.ts";
import { notification } from "./notification.ts";
import type { OutboxInput } from "./store.ts";

// Subscription usage limits (usageLimits in ocd.jsonc). Adapters report what
// the harness says: with every turn, or (for harnesses that can) on demand.
// This keeps the latest report per harness (in ~/.ocd/usage.json, so a restart
// still knows), and notifies once per window per threshold: "Claude usage at
// 82%". Thresholds are deduplicated by the outbox key, which includes the
// window's reset time, so the next window alerts again.

export interface UsageSettings {
  notifyAt: number[];
  pollMinutes: number;
}

export interface UsageTrackerOptions {
  file: string;
  settings: () => UsageSettings;
  enqueue: (entries: OutboxInput[]) => void;
  /** Reads that cost no tokens; polled every pollMinutes. */
  readers: (() => Promise<HarnessUsage | null>)[];
  logger: Logger;
  clock: Clock;
}

/** The reset time to the hour, so small drifts in what a harness reports do not re-alert. */
function resetKey(window: UsageWindow): string {
  return window.resetsAt ? String(Math.round(Date.parse(window.resetsAt) / 3_600_000)) : "none";
}

/** Which harnesses report limits, and how, for the "nothing reported yet" message. */
function emptyHint(): string {
  const labels = (kind: string) =>
    HARNESSES.filter((h) => h.usageLimits === kind).map((h) => h.label);
  const reported = labels("reported");
  const readable = labels("readable");
  const parts = [
    reported.length
      ? `${reported.join(", ")} report${reported.length === 1 ? "s" : ""} them while a worker runs`
      : "",
    readable.length
      ? `${readable.join(", ")} when it is enabled (ocd usage --refresh reads it now)`
      : "",
  ].filter(Boolean);
  return `No usage limits reported yet: ${parts.join(", ")}.`;
}

export class UsageTracker {
  private readonly latest = new Map<HarnessName, HarnessUsage>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<HarnessUsage[]> | null = null;

  private readonly o: UsageTrackerOptions;

  constructor(options: UsageTrackerOptions) {
    this.o = options;
    try {
      const saved = JSON.parse(readFileSync(options.file, "utf8")) as HarnessUsage[];
      for (const usage of saved) this.latest.set(usage.harness, usage);
    } catch {
      // Nothing recorded yet.
    }
  }

  start(): void {
    const minutes = this.o.settings().pollMinutes;
    if (minutes <= 0 || this.o.readers.length === 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): UsageStatus {
    return {
      harnesses: [...this.latest.values()]
        .map((u) => ({ ...u, label: labelOf(u.harness) }))
        .toSorted((a, b) => a.harness.localeCompare(b.harness)),
      notifyAt: this.o.settings().notifyAt,
      emptyHint: emptyHint(),
    };
  }

  /** Reads every harness that can be read without a model call, now. */
  async refresh(): Promise<UsageStatus> {
    this.polling ??= Promise.all(
      this.o.readers.map((read) =>
        read().catch((error: unknown) => {
          this.o.logger.warn({ err: error }, "usage limits read failed");
          return null;
        }),
      ),
    ).then(
      (results) => {
        this.polling = null;
        return results.filter((r): r is HarnessUsage => r !== null);
      },
      () => {
        this.polling = null;
        return [];
      },
    );
    // Readers emit `limits` events, which observe() records; this only waits.
    await this.polling;
    return this.status();
  }

  /** Records a harness's report and sends any notification it crosses. */
  observe(usage: HarnessUsage): void {
    const now = this.o.clock();
    const previous = this.latest.get(usage.harness);
    // A report may name only some windows; keep the others until they reset.
    const windows = new Map<string, UsageWindow>();
    for (const w of previous?.windows ?? []) if (!windowReset(w, now)) windows.set(w.id, w);
    for (const w of usage.windows) windows.set(w.id, w);
    const merged: HarnessUsage = {
      ...usage,
      plan: usage.plan ?? previous?.plan ?? null,
      windows: [...windows.values()],
    };
    this.latest.set(usage.harness, merged);
    this.save();
    this.alert(usage, now);
  }

  private alert(usage: HarnessUsage, now: number): void {
    const name = labelOf(usage.harness).replace(/ Code$/, "");
    const entries: OutboxInput[] = [];
    if (usage.state === "limited") {
      const window =
        usage.windows.find((w) => (w.usedPercent ?? 0) >= 100) ??
        usage.windows.toSorted((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
      const resets = window?.resetsAt ? ` · resets ${resetTime(window.resetsAt, now)}` : "";
      entries.push({
        kind: "notify",
        dedupeKey: `notify:usage:${usage.harness}:limited:${window ? `${window.id}:${resetKey(window)}` : new Date(now).toISOString().slice(0, 13)}`,
        payload: notification({
          headline: `${name} usage limit reached`,
          detail: `${window ? `The ${window.label} limit` : "The limit"} is used up${resets}`,
        }),
      });
    } else {
      const thresholds = [...this.o.settings().notifyAt].toSorted((a, b) => b - a);
      for (const w of usage.windows) {
        if (w.usedPercent === null || windowReset(w, now)) continue;
        const crossed = thresholds.find((t) => w.usedPercent! >= t);
        if (crossed === undefined) continue;
        const resets = w.resetsAt ? ` · resets ${resetTime(w.resetsAt, now)}` : "";
        entries.push({
          kind: "notify",
          dedupeKey: `notify:usage:${usage.harness}:${w.id}:${resetKey(w)}:${crossed}`,
          payload: notification({
            headline: `${name} usage at ${Math.round(w.usedPercent)}%`,
            detail: `You've used ${Math.round(w.usedPercent)}% of your ${w.label} limit${resets}`,
          }),
        });
      }
    }
    if (entries.length) this.o.enqueue(entries);
  }

  private save(): void {
    try {
      const tmp = `${this.o.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify([...this.latest.values()], null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmp, this.o.file);
    } catch (error) {
      this.o.logger.warn({ err: error }, "could not save usage limits");
    }
  }
}
