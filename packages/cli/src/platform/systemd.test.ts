import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Exec } from "./exec.ts";
import { SYSTEMD_UNIT, SystemdService, renderUnit, systemdQuote, unitPath } from "./systemd.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocd-systemd-"));
  dirs.push(dir);
  return dir;
}

const spec = {
  nodePath: "/home/me/.local/share/mise/installs/node/24.21.0/bin/node",
  cliPath: "/home/me/code/ocd 100%/packages/cli/dist/ocd.mjs",
  logsDir: "/home/me/.ocd/logs",
  env: { OCD_HOME: "/home/me/.ocd", OCD_CONFIG: undefined },
};

function fakeExec(responses: Record<string, { code: number; stdout?: string }> = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = responses[args[1]!] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: "" };
  };
  return { exec, calls };
}

describe("systemd user unit", () => {
  it("quotes words for systemd", () => {
    expect(systemdQuote('a "b" 100% $HOME \\')).toBe('"a \\"b\\" 100%% $$HOME \\\\"');
  });

  it("runs the pinned node and built CLI, restarting only after failures", () => {
    const unit = renderUnit(spec);
    expect(unit).toContain(
      'ExecStart="/home/me/.local/share/mise/installs/node/24.21.0/bin/node" "/home/me/code/ocd 100%%/packages/cli/dist/ocd.mjs" "daemon" "--background"',
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain('Environment="OCD_HOME=/home/me/.ocd"');
    expect(unit).not.toContain("OCD_CONFIG");
    expect(unit).toMatch(
      /Environment="PATH=\/home\/me\/.local\/share\/mise\/installs\/node\/24.21.0\/bin:/,
    );
    expect(unit).toContain("WantedBy=default.target");
  });

  it("lives under XDG_CONFIG_HOME", () => {
    expect(unitPath({ XDG_CONFIG_HOME: "/x" }, "/home/me")).toBe(`/x/systemd/user/${SYSTEMD_UNIT}`);
    expect(unitPath({}, "/home/me")).toBe(`/home/me/.config/systemd/user/${SYSTEMD_UNIT}`);
  });

  it("installs, enables and restarts; uninstalls only its own unit", async () => {
    const unit = join(temp(), "systemd", "user", SYSTEMD_UNIT);
    const { exec, calls } = fakeExec();
    const service = new SystemdService({ exec, unit, systemctl: "/usr/bin/systemctl" });
    await service.install({ ...spec, logsDir: temp() });
    expect(calls.map((c) => c.slice(1, 3).join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable",
      "--user restart",
    ]);
    expect(readFileSync(unit, "utf8")).toContain("--background");
    expect(await service.uninstall()).toEqual({ removed: true });
    expect(existsSync(unit)).toBe(false);
    expect(await service.uninstall()).toEqual({ removed: false });
    writeFileSync(unit, "[Service]\nExecStart=/bin/true\n");
    await expect(service.uninstall()).rejects.toThrow(/not written by ocd/);
    await expect(service.install({ ...spec, logsDir: temp() })).rejects.toThrow(
      /not written by ocd/,
    );
  });

  it("restarts the unit", async () => {
    const { exec, calls } = fakeExec();
    await new SystemdService({
      exec,
      unit: join(temp(), SYSTEMD_UNIT),
      systemctl: "systemctl",
    }).restart();
    expect(calls).toEqual([["systemctl", "--user", "restart", SYSTEMD_UNIT]]);
  });

  it("parses systemctl show", async () => {
    const unit = join(temp(), SYSTEMD_UNIT);
    writeFileSync(unit, renderUnit(spec));
    const { exec } = fakeExec({
      show: {
        code: 0,
        stdout:
          "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\n",
      },
    });
    expect(await new SystemdService({ exec, unit }).status()).toMatchObject({
      manager: "systemd",
      installed: true,
      loaded: true,
      state: "active (running)",
      pid: 4242,
    });
    const missing = fakeExec({ show: { code: 0, stdout: "LoadState=not-found\nMainPID=0\n" } });
    expect(
      await new SystemdService({ exec: missing.exec, unit: join(temp(), "x") }).status(),
    ).toMatchObject({
      installed: false,
      loaded: false,
      pid: null,
    });
  });
});
