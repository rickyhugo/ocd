import { windowLabels, type HarnessUsage, type UsageState, type UsageWindow } from "@ocd/core";

// Maps what Claude Code and Codex report about subscription usage limits into
// OCD's HarnessUsage. Shapes recorded against Claude Code 2.1.299
// (stream-json `rate_limit_event`) and codex 0.162.1 (`account/rateLimits/read`,
// `account/rateLimits/updated`).

const iso = (epochSeconds: unknown): string | null =>
  typeof epochSeconds === "number" && Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toISOString()
    : null;

const round = (n: number) => Math.round(n * 10) / 10;

const CLAUDE_WINDOWS: Record<string, { label: string; short: string }> = {
  five_hour: { label: "5-hour", short: "5h" },
  seven_day: { label: "weekly", short: "wk" },
  seven_day_opus: { label: "weekly Opus", short: "wk Opus" },
  seven_day_sonnet: { label: "weekly Sonnet", short: "wk Sonnet" },
};

function claudeWindow(id: string, utilization: unknown, resetsAt: unknown): UsageWindow {
  const names = CLAUDE_WINDOWS[id] ?? { label: id.replaceAll("_", " "), short: id };
  return {
    id,
    ...names,
    // Claude Code reports a fraction (it shows Math.round(utilization * 100)%).
    usedPercent:
      typeof utilization === "number" && Number.isFinite(utilization)
        ? round(utilization * 100)
        : null,
    resetsAt: iso(resetsAt),
  };
}

/** Claude Code's `rate_limit_event.rate_limit_info`. */
export interface ClaudeRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | null>;
}

export function claudeUsage(info: ClaudeRateLimitInfo, observedAt: string): HarnessUsage {
  const state: UsageState =
    info.status === "rejected" ? "limited" : info.status === "allowed_warning" ? "warning" : "ok";
  const windows: UsageWindow[] = [];
  for (const [id, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w && typeof w === "object") windows.push(claudeWindow(id, w.utilization, w.resetsAt));
  }
  // Without the per-window view, the event still describes the window it is about.
  if (!windows.length && info.rateLimitType)
    windows.push(claudeWindow(info.rateLimitType, info.utilization, info.resetsAt));
  return { harness: "claude", state, windows, plan: null, observedAt };
}

/** Codex's RateLimitSnapshot (v2 schema). */
interface CodexSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}
interface CodexWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

/** Codex's `account/rateLimits/read` result. */
export interface CodexRateLimitsResponse {
  ordinaryUsageAllowed?: boolean | null;
  rateLimits?: CodexSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexSnapshot | null | undefined> | null;
}

export function codexUsage(response: CodexRateLimitsResponse, observedAt: string): HarnessUsage {
  const buckets = Object.values(response.rateLimitsByLimitId ?? {}).filter(
    (b): b is CodexSnapshot => !!b,
  );
  if (!buckets.length && response.rateLimits) buckets.push(response.rateLimits);
  const windows: UsageWindow[] = [];
  let limited = response.ordinaryUsageAllowed === false;
  let plan: string | null = null;
  for (const bucket of buckets) {
    const limitId = bucket.limitId ?? "codex";
    // Model-specific buckets carry a name; the main one ("codex") does not need one.
    const prefix = limitId !== "codex" && bucket.limitName ? `${bucket.limitName} ` : "";
    if (bucket.rateLimitReachedType) limited = true;
    plan ??= bucket.planType ?? null;
    for (const w of [bucket.primary, bucket.secondary]) {
      if (!w || typeof w.usedPercent !== "number") continue;
      const names = windowLabels(w.windowDurationMins ?? null) ?? { label: "rolling", short: "" };
      windows.push({
        id: `${limitId}:${w.windowDurationMins ?? "window"}`,
        label: `${prefix}${names.label}`,
        short: `${prefix}${names.short}`.trim() || "usage",
        usedPercent: round(w.usedPercent),
        resetsAt: iso(w.resetsAt),
      });
    }
  }
  return { harness: "codex", state: limited ? "limited" : "ok", windows, plan, observedAt };
}
