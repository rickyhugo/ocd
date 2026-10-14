import type { TaskDiff, TaskDiffFile } from "./schemas.ts";

// Wording shared by the CLI, the manager tools and the TUI for a task's diff.

/** "+12 −3", or "binary". */
export function fileCounts(file: TaskDiffFile): string {
  return file.additions === null || file.deletions === null
    ? "binary"
    : `+${file.additions} −${file.deletions}`;
}

/** Totals over all files: "3 files, +40 −7". */
export function diffTotals(diff: TaskDiff): string {
  const add = diff.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const del = diff.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const n = diff.files.length;
  return `${n} file${n === 1 ? "" : "s"}, +${add} −${del}`;
}

const STATUS: Record<TaskDiffFile["status"], string> = { added: "A", deleted: "D", modified: "M" };

/** A header and one line per file, like `git diff --stat`. */
export function formatDiffStat(diff: TaskDiff): string {
  const width = Math.min(60, Math.max(0, ...diff.files.map((f) => f.path.length)));
  return [
    `${diff.branch ?? diff.taskId} vs ${diff.baseRef} (since ${diff.mergeBase.slice(0, 7)}): ${diffTotals(diff)}`,
    ...diff.files.map(
      (f) =>
        `  ${STATUS[f.status]} ${f.path.padEnd(width)}  ${fileCounts(f)}${f.uncommitted ? "  (uncommitted)" : ""}`,
    ),
    ...(diff.truncated ? ["  (patch truncated)"] : []),
  ].join("\n");
}

/** The patch split per file, in patch order. */
export function splitPatch(patch: string): { path: string; patch: string }[] {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((part) => {
    const header = part.slice(0, part.indexOf("\n"));
    // "diff --git a/x b/x"; new files from --no-index read "a/dev/null b/x".
    const match = / b\/(.+)$/.exec(header);
    return { path: match?.[1] ?? header, patch: part };
  });
}
