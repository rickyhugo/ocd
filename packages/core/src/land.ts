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
  const shown = plan.commits.slice(-maxCommits).map((c) => `  ${c.sha.slice(0, 7)} ${c.subject}`);
  return [
    `Push "${plan.title}" (${plan.taskId}, repo ${plan.repo}) to ${plan.remote}/${plan.base} ${how}:`,
    ...(n > maxCommits ? [`  … ${n - maxCommits} earlier`] : []),
    ...shown,
    `${plan.files.length} file${plan.files.length === 1 ? "" : "s"} changed. A plain push: never forced; hooks and branch protection apply.`,
  ].join("\n");
}

/** One line on what `land` did and what is left. */
export function describeLandResult(result: LandResult): string {
  const done = result.steps.join("; ");
  if (result.landed) return done ? `landed: ${done}` : "already landed";
  const left = result.waiting ? result.waiting.message : "not landed";
  return done ? `${done}. Not landed yet: ${left}` : `Not landed yet: ${left}`;
}
