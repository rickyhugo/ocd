import { describe, expect, it } from "vite-plus/test";

import { parsePorcelainZ } from "./workspace.ts";

describe("git status parsing", () => {
  it("keeps the first path intact when the status column starts with a space", () => {
    expect(parsePorcelainZ(" M README.md\0?? new.txt\0")).toEqual(["README.md", "new.txt"]);
  });

  it("reports the new path of renames and skips the original", () => {
    expect(parsePorcelainZ("R  new name.md\0old name.md\0 D gone.txt\0")).toEqual([
      "new name.md",
      "gone.txt",
    ]);
  });
});
