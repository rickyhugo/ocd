import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Exec } from "./exec.ts";
import { LAUNCH_AGENT_LABEL, LaunchdService, renderPlist } from "./launchd.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocd-la-"));
  dirs.push(dir);
  return dir;
}

const spec = {
  nodePath: "/Users/me/.local/share/mise/installs/node/24.21.0/bin/node",
  cliPath: "/Users/me/code/ocd & co/packages/cli/dist/ocd.mjs",
  logsDir: "/Users/me/.ocd/logs",
  env: { OCD_HOME: "/Users/me/.ocd", OCD_CONFIG: undefined },
};

function fakeExec(
  responses: Record<string, { code: number; stdout?: string; stderr?: string }> = {},
) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = responses[args[0]!] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

describe("LaunchAgent plist", () => {
  it("runs the pinned node and built CLI in background mode with absolute paths", () => {
    const plist = renderPlist(spec);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain(
      "<string>/Users/me/.local/share/mise/installs/node/24.21.0/bin/node</string>",
    );
    expect(plist).toContain("<string>daemon</string>\n      <string>--background</string>");
    expect(plist).toContain("ocd &amp; co");
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain("<key>OCD_HOME</key>");
    expect(plist).not.toContain("OCD_CONFIG");
    expect(plist).toMatch(
      /<key>PATH<\/key>\s*<string>\/Users\/me\/.local\/share\/mise\/installs\/node\/24.21.0\/bin:/,
    );
  });

  it("is a valid property list", () => {
    if (process.platform !== "darwin") return;
    const file = join(temp(), "agent.plist");
    writeFileSync(file, renderPlist(spec));
    expect(execFileSync("/usr/bin/plutil", ["-lint", file]).toString()).toMatch(/OK/);
  });
});

describe("LaunchAgent lifecycle", () => {
  it("installs by replacing any loaded definition, then bootstrapping", async () => {
    const plist = join(temp(), "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
    const { exec, calls } = fakeExec({ bootout: { code: 3 } });
    await new LaunchdService({ exec, plist }).install({ ...spec, logsDir: temp() });
    expect(calls.map((c) => c[1])).toEqual(["bootout", "bootstrap"]);
    expect(calls[1]).toEqual(["/bin/launchctl", "bootstrap", `gui/${process.getuid!()}`, plist]);
    expect(readFileSync(plist, "utf8")).toContain("--background");
  });

  it("restarts with SIGTERM, waits for the exit, then kickstarts without -k", async () => {
    const target = `gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`;
    const calls: string[][] = [];
    let prints = 0;
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") {
        prints += 1;
        return {
          code: 0,
          stdout: prints < 3 ? "\tpid = 123\n" : "\tstate = not running\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await new LaunchdService({
      exec,
      plist: join(temp(), "x.plist"),
      sleep: async () => {},
    }).restart();
    expect(calls[0]).toEqual(["/bin/launchctl", "kill", "SIGTERM", target]);
    expect(calls.at(-1)).toEqual(["/bin/launchctl", "kickstart", target]);
    expect(calls.flat()).not.toContain("-k");
    expect(prints).toBe(3);
  });

  it("does not SIGKILL a supervisor that will not exit, and reports a missing service", async () => {
    const stuck: Exec = async (_c, args) => ({
      code: 0,
      stdout: args[0] === "print" ? "\tpid = 123\n" : "",
      stderr: "",
    });
    await expect(
      new LaunchdService({
        exec: stuck,
        plist: join(temp(), "x.plist"),
        stopTimeoutMs: 0,
        sleep: async () => {},
      }).restart(),
    ).rejects.toThrow(/did not exit/);
    const missing = fakeExec({
      kill: { code: 113, stderr: "Could not find service" },
      print: { code: 113, stderr: "Could not find service" },
    });
    await expect(
      new LaunchdService({ exec: missing.exec, plist: join(temp(), "x.plist") }).restart(),
    ).rejects.toThrow(/Could not find service/);
  });

  it("reports bootstrap failures", async () => {
    const plist = join(temp(), `${LAUNCH_AGENT_LABEL}.plist`);
    const { exec, calls } = fakeExec({
      bootout: { code: 3 },
      bootstrap: { code: 5, stderr: "Input/output error" },
    });
    await expect(
      new LaunchdService({ exec, plist, sleep: async () => undefined }).install({
        ...spec,
        logsDir: temp(),
      }),
    ).rejects.toThrow(/Input\/output error/);
    // Retried a few times before giving up.
    expect(calls.filter((c) => c[1] === "bootstrap")).toHaveLength(5);
  });

  it("waits for a replaced supervisor to be gone before bootstrapping the new definition", async () => {
    // As launchd does: bootout returns at once, the old job lingers while it
    // stops, and bootstrapping meanwhile fails with an I/O error.
    const plist = join(temp(), `${LAUNCH_AGENT_LABEL}.plist`);
    const calls: string[][] = [];
    let prints = 0;
    let bootstraps = 0;
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "print") return { code: ++prints < 3 ? 0 : 113, stdout: "", stderr: "" };
      if (args[0] === "bootstrap")
        return ++bootstraps === 1
          ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
          : { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await new LaunchdService({ exec, plist, sleep: async () => undefined }).install({
      ...spec,
      logsDir: temp(),
    });
    expect(calls.map((c) => c[1])).toEqual([
      "bootout",
      "print",
      "print",
      "print",
      "bootstrap",
      "bootstrap",
    ]);
  });

  it("uninstalls only its own plist", async () => {
    const dir = temp();
    const plist = join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
    const { exec } = fakeExec();
    writeFileSync(plist, renderPlist(spec));
    expect(await new LaunchdService({ exec, plist }).uninstall()).toEqual({ removed: true });
    expect(existsSync(plist)).toBe(false);
    expect(await new LaunchdService({ exec, plist }).uninstall()).toEqual({ removed: false });
    writeFileSync(plist, "<plist>someone else</plist>");
    await expect(new LaunchdService({ exec, plist }).uninstall()).rejects.toThrow(
      /does not look like/,
    );
  });

  it("parses launchctl state", async () => {
    const plist = join(temp(), `${LAUNCH_AGENT_LABEL}.plist`);
    writeFileSync(plist, renderPlist(spec));
    const { exec } = fakeExec({
      print: {
        code: 0,
        stdout: "dev.ocd.supervisor = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}",
      },
    });
    expect(await new LaunchdService({ exec, plist }).status()).toMatchObject({
      installed: true,
      loaded: true,
      state: "running",
      pid: 4242,
      lastExitCode: "0",
    });
    const missing = fakeExec({ print: { code: 113, stderr: "Could not find service" } });
    expect(
      await new LaunchdService({ exec: missing.exec, plist: join(temp(), "x.plist") }).status(),
    ).toMatchObject({ installed: false, loaded: false, pid: null });
  });
});
