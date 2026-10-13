import { describe, expect, it } from "vite-plus/test";

import { openSessionWindow, shellLine, type Exec } from "./session-window.ts";

function recorder(windows = "") {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: args[0] === "list-windows" ? windows : "" };
  };
  return { exec, calls };
}

describe("session windows", () => {
  const base = { taskId: "t_mv6abc123456", cwd: "/ws/t 1", command: ["claude", "--resume", "s-1"] };

  it("opens a named tmux window in the worktree", async () => {
    const { exec, calls } = recorder("@1\tzsh\n");
    expect(await openSessionWindow({ ...base, env: { TMUX: "x" }, exec })).toBe("ocd-123456");
    expect(calls.at(-1)).toEqual([
      "tmux",
      "new-window",
      "-n",
      "ocd-123456",
      "-c",
      "/ws/t 1",
      "claude",
      "--resume",
      "s-1",
    ]);
  });

  it("focuses the existing window instead of opening a second one", async () => {
    const { exec, calls } = recorder("@1\tzsh\n@7\tocd-123456\n");
    await openSessionWindow({ ...base, env: { TMUX: "x" }, exec });
    expect(calls.slice(1).map((c) => c.slice(1).join(" "))).toEqual([
      "switch-client -t @7",
      "select-window -t @7",
    ]);
  });

  it("does nothing outside tmux; the command is shown instead", async () => {
    const { exec, calls } = recorder();
    expect(await openSessionWindow({ ...base, env: {}, exec })).toBeNull();
    expect(calls).toEqual([]);
    expect(shellLine(base.cwd, base.command)).toBe("cd '/ws/t 1' && claude --resume s-1");
  });
});
