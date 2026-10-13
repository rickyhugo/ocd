import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { shellQuote, type Exec } from "./exec.ts";
import { focusManager, managerPane } from "./focus.ts";
import { LinuxPlatform, MacPlatform } from "./index.ts";
import {
  FallbackNotifier,
  NotifySendNotifier,
  OsascriptNotifier,
  TerminalNotifier,
} from "./notify.ts";
import { identifyTerminal } from "./terminal.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocd-platform-"));
  dirs.push(dir);
  return dir;
}

function recordingExec(responses: Record<string, { code?: number; stdout?: string }> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = responses[`${cmd} ${args[0]}`] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("terminals", () => {
  it("identifies the terminal from tmux's termtype or termname", () => {
    expect(identifyTerminal("ghostty 1.3.1")?.macBundle).toBe("com.mitchellh.ghostty");
    expect(identifyTerminal("", "xterm-kitty")?.linuxClass).toBe("kitty");
    expect(identifyTerminal("iTerm2 3.5.10")?.macBundle).toBe("com.googlecode.iterm2");
    expect(identifyTerminal("", "xterm-256color")).toBeNull();
  });
});

describe("notifiers", () => {
  it("quotes the click command for the shell", () => {
    expect(shellQuote(["/a b/node", "it's", "focus"])).toBe(`'/a b/node' 'it'\\''s' 'focus'`);
  });

  it("terminal-notifier runs the click command; osascript passes text as argv", async () => {
    const { exec, calls } = recordingExec();
    await new TerminalNotifier({ binary: "/bin/tn", onClick: ["/n", "ocd", "focus"], exec }).notify(
      {
        title: "Task ready",
        body: "token sk-abcdefghijklmnopqrstuvwxyz0123",
      },
    );
    expect(calls[0]?.slice(0, 3)).toEqual(["/bin/tn", "-title", "Task ready"]);
    expect(calls[0]).toContain("-execute");
    expect(calls[0]?.at(-1)).toBe("'/n' 'ocd' 'focus'");
    expect(calls[0]?.join(" ")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    await new OsascriptNotifier({ exec }).notify({ title: 'a" & b', body: "c" });
    expect(calls[1]?.slice(-2)).toEqual(['a" & b', "c"]);
  });

  it("falls back when terminal-notifier lacks permission, and recovers once allowed", async () => {
    let allowed = false;
    const calls: string[] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      if (cmd === "/bin/tn" && !allowed)
        return {
          code: 3,
          stdout: "",
          stderr:
            "Could not request notification permission: Notifications are not allowed for this application",
        };
      return { code: 0, stdout: "", stderr: "" };
    };
    const notifier = new FallbackNotifier(
      new TerminalNotifier({ binary: "/bin/tn", onClick: ["focus"], exec }),
      new OsascriptNotifier({ exec }),
    );
    await notifier.notify({ title: "t", body: "b" });
    expect(calls).toEqual(["/bin/tn", "/usr/bin/osascript"]);
    expect(notifier.lastError?.message).toMatch(/not allowed/);
    allowed = true;
    await notifier.notify({ title: "t", body: "b" });
    expect(calls.slice(2)).toEqual(["/bin/tn"]);
    expect(notifier.lastError).toBeNull();
  });

  it("surfaces a failing backend so the outbox retries", async () => {
    const { exec } = recordingExec({ "/bin/tn -title": { code: 1 } });
    await expect(
      new TerminalNotifier({ binary: "/bin/tn", exec }).notify({ title: "t", body: "b" }),
    ).rejects.toThrow(/exited 1/);
  });

  it("notify-send runs the click command when the default action is invoked", async () => {
    const dir = temp();
    const fake = join(dir, "notify-send");
    const marker = join(dir, "clicked");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho default\n`);
    chmodSync(fake, 0o755);
    const notifier = new NotifySendNotifier({
      binary: fake,
      onClick: ["/usr/bin/touch", marker],
      supportsActions: true,
    });
    expect(notifier.clickable).toBe(true);
    await notifier.notify({ title: "Needs you", body: "permission" });
    await until(() => existsSync(marker));
    expect(readFileSync(join(dir, "args"), "utf8").split("\n")).toEqual(
      expect.arrayContaining(["--action=default=Open", "--wait", "--app-name=OCD", "Needs you"]),
    );
  });

  it("older notify-send gets a plain notification", async () => {
    const { exec, calls } = recordingExec();
    const notifier = new NotifySendNotifier({
      binary: "/bin/ns",
      onClick: ["x"],
      supportsActions: false,
      exec,
    });
    expect(notifier.clickable).toBe(false);
    await notifier.notify({ title: "t", body: "b" });
    expect(calls).toEqual([["/bin/ns", "--app-name=OCD", "t", "b"]]);
  });

  it("hands every backend plain text that cannot pass for an option", async () => {
    const { exec, calls } = recordingExec();
    const message = {
      title: "OCD: Review\nready\u001b[31m",
      body: "--help \u0007me\u202e\napp · 1 file changed\n\n",
    };
    await new TerminalNotifier({ binary: "/bin/tn", exec }).notify(message);
    await new OsascriptNotifier({ exec }).notify(message);
    await new NotifySendNotifier({ binary: "/bin/ns", supportsActions: false, exec }).notify(
      message,
    );
    const expected = ["OCD: Review ready", "help me\napp · 1 file changed"];
    expect(calls[0]).toEqual(["/bin/tn", "-title", expected[0], "-message", expected[1]]);
    expect(calls[1]?.slice(-2)).toEqual(expected);
    expect(calls[2]).toEqual(["/bin/ns", "--app-name=OCD", ...expected]);
  });
});

describe("raising the terminal", () => {
  it("uses open -b on macOS", async () => {
    const { exec, calls } = recordingExec();
    expect(
      await new MacPlatform({ exec }).activate({
        name: "ghostty",
        macBundle: "com.mitchellh.ghostty",
      }),
    ).toBe(true);
    expect(calls).toEqual([["/usr/bin/open", "-b", "com.mitchellh.ghostty"]]);
  });

  it("gives up on Linux without a compositor it can drive", async () => {
    const { exec, calls } = recordingExec();
    const linux = new LinuxPlatform({ exec, env: { WAYLAND_DISPLAY: "wayland-0" } });
    expect(await linux.activate({ name: "kitty", linuxClass: "kitty" })).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("ocd focus", () => {
  it("prefers the pane running OpenCode in the manager directory", () => {
    const panes = [
      { id: "%1", path: "/tmp/elsewhere", command: "opencode", session: "a", window: "@1" },
      { id: "%2", path: "/tmp/mgr", command: "zsh", session: "ocd", window: "@2" },
      { id: "%3", path: "/tmp/mgr", command: "opencode", session: "ocd", window: "@3" },
    ];
    expect(managerPane(panes, "/tmp/mgr")?.id).toBe("%3");
    expect(managerPane(panes.slice(0, 2), "/tmp/mgr")?.id).toBe("%2");
    expect(managerPane(panes, "/tmp/none")).toBeNull();
  });

  it("switches tmux to the manager pane and raises the detected terminal", async () => {
    const { exec, calls } = recordingExec({
      "tmux list-panes": {
        stdout: "%7\t/tmp/mgr\topencode\tocd\t@4\n%8\t/tmp/x\tzsh\tother\t@5\n",
      },
      "tmux list-clients": { stdout: "ghostty 1.3.1\txterm-ghostty\n" },
    });
    const raised: string[] = [];
    const steps = await focusManager({
      directory: "/tmp/mgr",
      tmux: "tmux",
      exec,
      activate: async (app) => {
        raised.push(app.name);
        return true;
      },
    });
    expect(calls.map((c) => c.slice(1).join(" "))).toEqual(
      expect.arrayContaining(["switch-client -t %7", "select-window -t @4", "select-pane -t %7"]),
    );
    expect(raised).toEqual(["ghostty"]);
    expect(steps.join("\n")).toMatch(/pane %7[\s\S]*raised ghostty/);
  });

  it("raises the configured app without tmux", async () => {
    const { exec } = recordingExec();
    const raised: (string | undefined)[] = [];
    await focusManager({
      directory: "/tmp/mgr",
      tmux: null,
      focusApp: "org.wezfurlong.wezterm",
      exec,
      activate: async (app) => {
        raised.push(app.linuxClass);
        return true;
      },
    });
    expect(raised).toEqual(["org.wezfurlong.wezterm"]);
  });
});
