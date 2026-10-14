import { describe, expect, it } from "vite-plus/test";

import { formatLandPlan } from "./land.ts";
import type { LandPlan } from "./schemas.ts";

describe("formatLandPlan", () => {
  it("shows worker-controlled text without escape sequences or carriage returns", () => {
    const plan: LandPlan = {
      taskId: "t_1",
      title: "Fix\u001b[2K\rSAFE title",
      repo: "app\u001b]0;x\u0007",
      remote: "origin",
      base: "main",
      method: "squash",
      head: "abcdef1234",
      commits: [{ sha: "abcdef1234", subject: "real\r\u001b[1Aharmless" }],
      files: ["a.ts"],
      dirty: false,
      pullRequestUrl: null,
      blocker: null,
    };
    const text = formatLandPlan(plan);
    for (const bad of ["\u001b", "\r", "\u0007"]) expect(text).not.toContain(bad);
    expect(text).toContain("real harmless");
  });
});
