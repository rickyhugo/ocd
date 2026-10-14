import { describe, expect, it } from "vite-plus/test";

import { doctorProblems } from "./harnesses.ts";

const ok = {
  configError: null,
  git: "/usr/bin/git",
  harnesses: [{ harness: "opencode" as const, available: true }],
  github: { enabled: false, available: null },
  tmux: { enabled: false, path: null },
};

describe("doctorProblems", () => {
  it("is empty when everything enabled works; off tools do not count", () => {
    expect(doctorProblems(ok)).toEqual([]);
  });

  it("flags a bad config, missing git, and unavailable enabled harnesses or tools", () => {
    expect(
      doctorProblems({
        configError: "bad",
        git: null,
        harnesses: [{ harness: "claude", available: false }],
        github: { enabled: true, available: false },
        tmux: { enabled: true, path: null },
      }),
    ).toEqual([
      "invalid config",
      "git not found",
      "claude unavailable",
      "gh unavailable",
      "tmux not found",
    ]);
  });
});
