import { describe, expect, it } from "vite-plus/test";

import { baseLabel, diffTotals, fileCounts, formatDiffStat, splitPatch } from "./diff.ts";
import type { TaskDiff } from "./schemas.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/dev/null b/notes.md
new file mode 100644
--- /dev/null
+++ b/notes.md
@@ -0,0 +1 @@
+hello
`;

const DIFF: TaskDiff = {
  taskId: "t_1",
  branch: "ocd/t_1",
  baseRef: "main",
  mergeBase: "abcdef1234567890",
  head: "1234567abcdef",
  files: [
    { path: "img.png", status: "added", additions: null, deletions: null, uncommitted: false },
    { path: "notes.md", status: "added", additions: 1, deletions: 0, uncommitted: true },
    { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, uncommitted: false },
  ],
  patch: PATCH,
  truncated: false,
};

describe("task diff wording", () => {
  it("splits a patch per file, including untracked files diffed against /dev/null", () => {
    expect(splitPatch(PATCH).map((p) => p.path)).toEqual(["src/a.ts", "notes.md"]);
    expect(splitPatch(PATCH)[1]!.patch).toContain("+hello");
    expect(splitPatch("")).toEqual([]);
  });

  it("shortens a commit-hash base and skips a redundant merge base", () => {
    const sha = "c57f6e071fe8d8342b03df6c6f7d96460bbc3361";
    expect(baseLabel({ ...DIFF, baseRef: sha })).toBe("c57f6e0");
    expect(formatDiffStat({ ...DIFF, baseRef: sha, mergeBase: sha }).split("\n")[0]).toBe(
      "ocd/t_1 vs c57f6e0: 3 files, +2 −1",
    );
  });

  it("summarizes files and totals, marking binary and uncommitted files", () => {
    expect(fileCounts(DIFF.files[0]!)).toBe("binary");
    expect(diffTotals(DIFF)).toBe("3 files, +2 −1");
    expect(formatDiffStat(DIFF).split("\n")).toEqual([
      "ocd/t_1 vs main (since abcdef1): 3 files, +2 −1",
      "  A img.png   binary",
      "  A notes.md  +1 −0  (uncommitted)",
      "  M src/a.ts  +1 −1",
    ]);
  });
});
