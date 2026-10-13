import { WorkerReport } from "./schemas.ts";

const FENCE = "ocd-report";

/** Appended to worker instructions so results can be collected structurally. */
export const REPORT_INSTRUCTIONS = `When you have finished (or cannot continue), end your final message with a fenced block tagged \`${FENCE}\` containing JSON with exactly these fields:

\`\`\`${FENCE}
{"summary": "what you did and why", "changedFiles": ["path/relative/to/repo"], "tests": [{"command": "command you ran", "outcome": "passed|failed|not_run", "details": "optional"}], "unresolved": ["anything left open or uncertain"]}
\`\`\`

Report only what you actually did. Do not merge, push to protected branches, or delete work.`;

export type ParsedReport = { ok: true; report: WorkerReport } | { ok: false; error: string };

/** Parses the last `ocd-report` block from a worker's final message. */
export function parseWorkerReport(text: string): ParsedReport {
  const blocks = [...text.matchAll(/```ocd-report[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last?.[1]) return { ok: false, error: "No ocd-report block in the final message" };
  let json: unknown;
  try {
    json = JSON.parse(last[1]);
  } catch (error) {
    return { ok: false, error: `ocd-report block is not valid JSON: ${(error as Error).message}` };
  }
  const parsed = WorkerReport.safeParse(json);
  if (!parsed.success)
    return { ok: false, error: `ocd-report block is invalid: ${parsed.error.message}` };
  return { ok: true, report: parsed.data };
}
