import type { HarnessName } from "./schemas.ts";

// Subscription usage limits as the harnesses report them (with a worker's
// turns, or read without a model call), and the wording shared by the
// CLI, the TUI and the manager briefing. OCD only records what a harness says;
// it never estimates usage itself.

/** One rolling usage window, e.g. a 5-hour or a weekly one. */
export interface UsageWindow {
  /** Stable per harness, as the harness names it (five_hour, seven_day, …). */
  id: string;
  /** "5-hour", "weekly", "weekly Opus" */
  label: string;
  /** "5h", "wk", "wk Opus": for the sidebar. */
  short: string;
  /** 0–100, as reported; null when the harness gave only a status. */
  usedPercent: number | null;
  resetsAt: string | null;
}

/** ok: usage allowed. warning: the harness says a limit is near. limited: requests are refused. */
export type UsageState = "ok" | "warning" | "limited";

export interface HarnessUsage {
  harness: HarnessName;
  /** The harness's display name; the supervisor fills it in from the registry. */
  label?: string;
  state: UsageState;
  windows: UsageWindow[];
  /** Subscription plan, when the harness says. */
  plan: string | null;
  /** When OCD last heard from the harness about it. */
  observedAt: string;
}

export interface UsageStatus {
  harnesses: HarnessUsage[];
  /** usageLimits.notifyAt: percentages that send a notification once per window. */
  notifyAt: number[];
  /** What to say while nothing is reported yet: which harnesses report limits, and how. */
  emptyHint?: string;
}

export function harnessLabel(usage: Pick<HarnessUsage, "harness" | "label">): string {
  return usage.label ?? usage.harness;
}

/** "5-hour" / "weekly" / "3-day" from a window length in minutes. */
export function windowLabels(minutes: number | null): { label: string; short: string } | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes === 10_080) return { label: "weekly", short: "wk" };
  if (minutes % 1440 === 0) return { label: `${minutes / 1440}-day`, short: `${minutes / 1440}d` };
  if (minutes % 60 === 0) return { label: `${minutes / 60}-hour`, short: `${minutes / 60}h` };
  return { label: `${minutes}-minute`, short: `${minutes}m` };
}

/** The window reset after it was observed, so its percentage no longer applies. */
export function windowReset(window: UsageWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local time of a reset: "16:40" within a day, "Thu 14:00" within a week, else "21 Oct". */
export function resetTime(iso: string, now: number): string {
  const at = new Date(iso);
  const ms = at.getTime() - now;
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (ms < 86_400_000) return clock;
  if (ms < 7 * 86_400_000) return `${WEEKDAYS[at.getDay()]} ${clock}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function percent(window: UsageWindow): string {
  return window.usedPercent === null ? "?" : `${Math.round(window.usedPercent)}%`;
}

/** "5-hour 62% (resets 16:40)", or "5-hour reset at 16:40" once it has. */
export function windowText(window: UsageWindow, now: number): string {
  if (windowReset(window, now))
    return `${window.label} reset at ${resetTime(window.resetsAt!, now)}`;
  const resets = window.resetsAt ? ` (resets ${resetTime(window.resetsAt, now)})` : "";
  return `${window.label} ${percent(window)}${resets}`;
}

/** One line per harness, for `ocd usage`, `ocd status` and the manager briefing. */
export function usageLines(harnesses: HarnessUsage[], now: number): string[] {
  return harnesses.map((h) => {
    const state =
      h.state === "limited" ? "LIMIT REACHED · " : h.state === "warning" ? "near a limit · " : "";
    const windows = h.windows.map((w) => windowText(w, now)).join(" · ") || "no windows reported";
    return `${harnessLabel(h)}: ${state}${windows} · seen ${ago(h.observedAt, now)}`;
  });
}

/** The highest current percentage across a harness's windows that have not reset. */
export function peakPercent(h: HarnessUsage, now: number): number | null {
  const values = h.windows
    .filter((w) => !windowReset(w, now) && w.usedPercent !== null)
    .map((w) => w.usedPercent!);
  return values.length ? Math.max(...values) : null;
}

/**
 * The sidebar's one line: `claude 5h 8% wk 63% · codex wk 22%`. Tone: error
 * when a harness is limited, warning at or above the lowest notifyAt.
 */
export function usageSummary(
  status: UsageStatus | null | undefined,
  now: number,
): { text: string; tone: "muted" | "warning" | "error" } | null {
  if (!status?.harnesses.length) return null;
  const warnAt = status.notifyAt.length ? Math.min(...status.notifyAt) : 80;
  let tone: "muted" | "warning" | "error" = "muted";
  const parts = status.harnesses.map((h) => {
    if (h.state === "limited") tone = "error";
    else if (tone === "muted" && (h.state === "warning" || (peakPercent(h, now) ?? 0) >= warnAt))
      tone = "warning";
    const windows = h.windows
      .map((w) => `${w.short} ${windowReset(w, now) ? "↻" : percent(w)}`)
      .join(" ");
    return `${h.harness} ${h.state === "limited" ? "limited" : windows}`.trim();
  });
  return { text: parts.join(" · "), tone };
}
