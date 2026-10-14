import { plainText } from "./redact.ts";
import type { LandPlan, LandResult } from "./schemas.ts";

// Wording shared by the CLI and the TUI for landing a task.

/** What a direct landing will do, for the human to confirm. */
export function formatLandPlan(plan: LandPlan, maxCommits = 15): string {
  const n = plan.commits.length;
  const commits = `${n} commit${n === 1 ? "" : "s"}`;
  const how =
    plan.method === "squash"
      ? `as one squashed commit (${commits})`
      : plan.method === "merge"
        ? `as a merge commit (${commits})`
        : `replaying ${commits}`;
  // Worker-controlled text: no escape sequences or control characters, so
  // nothing can hide what the human is about to approve.
  const t = (value: string) => plainText(value);
  const shown = plan.commits
    .slice(-maxCommits)
    .map((c) => `  ${t(c.sha).slice(0, 7)} ${t(c.subject)}`);
  return [
    `Push "${t(plan.title)}" (${t(plan.taskId)}, repo ${t(plan.repo)}) to ${t(plan.remote)}/${t(plan.base)} ${how}:`,
    ...(n > maxCommits ? [`  … ${n - maxCommits} earlier`] : []),
    ...shown,
    `${plan.files.length} file${plan.files.length === 1 ? "" : "s"} changed. A plain push: never forced; hooks and branch protection apply.`,
  ].join("\n");
}

/** One line on what `land` did and what is left. */
export function describeLandResult(result: LandResult): string {
  const done = result.steps.map((s) => plainText(s)).join("; ");
  if (result.landed) return done ? `landed: ${done}` : "already landed";
  const left = result.waiting ? plainText(result.waiting.message) : "not landed";
  return done ? `${done}. Not landed yet: ${left}` : `Not landed yet: ${left}`;
}
