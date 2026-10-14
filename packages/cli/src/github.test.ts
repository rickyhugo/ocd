import type { GitHubCliStatus } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { describeGh } from "./github.ts";

const ok: GitHubCliStatus = {
  available: true,
  path: "/shell/bin/gh",
  version: "2.100.0",
  auth: "ok",
  problem: null,
  problems: [],
  checkedAt: new Date(0).toISOString(),
};

describe("describing gh status", () => {
  it("is explicit about the path, login and problems", () => {
    expect(describeGh(ok)).toBe("ok 2.100.0 /shell/bin/gh, logged in");
    expect(
      describeGh({
        ...ok,
        auth: "unknown",
        problem: "unreachable",
        problems: ["GitHub could not be reached"],
      }),
    ).toBe("ok 2.100.0 /shell/bin/gh, login not verified; GitHub could not be reached");
    expect(describeGh({ ...ok, auth: "missing", problems: ["Run `gh auth login`"] })).toContain(
      "login missing",
    );
    expect(
      describeGh({ ...ok, available: false, path: null, problems: ["gh was not found"] }),
    ).toBe("UNAVAILABLE gh was not found");
  });
});
