import { describe, expect, it } from "vite-plus/test";

import { matchTasks } from "./task-match.ts";

const tasks = [
  { id: "t_mv6ljnk9e84bd4", title: "Calculate Lua lines of code", repo: "dotfiles" },
  { id: "t_mv6ip5fi6bfc48", title: "Add concise, funny README", repo: "dotfiles" },
  { id: "t_mv6m4wdd3a8f62", title: "Smoke test", repo: "smoke" },
];

describe("task references", () => {
  it("matches full ids and id suffixes", () => {
    expect(matchTasks(tasks, "t_mv6ljnk9e84bd4").map((t) => t.title)).toEqual([
      "Calculate Lua lines of code",
    ]);
    expect(matchTasks(tasks, "84bd4").map((t) => t.repo)).toEqual(["dotfiles"]);
  });

  it("matches words across title and repo, case-insensitively", () => {
    expect(matchTasks(tasks, "lua dotfiles")).toHaveLength(1);
    expect(matchTasks(tasks, "dotfiles")).toHaveLength(2);
    expect(matchTasks(tasks, "nothing")).toEqual([]);
    expect(matchTasks(tasks, "  ")).toHaveLength(3);
  });
});
