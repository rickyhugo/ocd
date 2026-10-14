import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { execCommand, servicePath, type Exec } from "./exec.ts";
import {
  serviceEnv,
  type ServiceManager,
  type ServiceSpec,
  type ServiceStatus,
} from "./service.ts";

// User LaunchAgent for the supervisor. launchd does not inherit an
// interactive shell's PATH or mise activation, so everything is absolute.

export const LAUNCH_AGENT_LABEL = "dev.ocd.supervisor";

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderPlist(spec: ServiceSpec): string {
  const envXml = Object.entries(serviceEnv(spec, servicePath(spec.nodePath, "darwin")))
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.nodePath)}</string>
      <string>${xml(spec.cliPath)}</string>
      <string>daemon</string>
      <string>--background</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Restart after a crash, not after a clean \`ocd stop\`. -->
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(join(spec.logsDir, "launchd.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(join(spec.logsDir, "launchd.err.log"))}</string>
  </dict>
</plist>
`;
}

export class LaunchdService implements ServiceManager {
  readonly kind = "launchd";
  private readonly exec: Exec;
  private readonly plist: string;
  private readonly stopTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    options: {
      exec?: Exec;
      plist?: string;
      /** How long a restart waits for the old instance to exit after SIGTERM. */
      stopTimeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.exec = options.exec ?? execCommand;
    this.plist = options.plist ?? plistPath();
    this.stopTimeoutMs = options.stopTimeoutMs ?? 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private target(): string {
    if (typeof process.getuid !== "function") throw new Error("launchd needs a POSIX user id");
    return `gui/${process.getuid()}`;
  }

  async install(spec: ServiceSpec): Promise<{ definition: string }> {
    mkdirSync(dirname(this.plist), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true, mode: 0o700 });
    // Replace an older definition if one is loaded; a missing one is fine.
    const service = `${this.target()}/${LAUNCH_AGENT_LABEL}`;
    const unloaded = await this.exec("/bin/launchctl", ["bootout", service]);
    writeFileSync(this.plist, renderPlist(spec), { mode: 0o644 });
    // bootout returns before the old supervisor has finished stopping, and
    // bootstrapping the label meanwhile fails with an I/O error: wait until
    // launchd no longer knows the job (bounded), and retry that error briefly.
    if (unloaded.code === 0) {
      for (let waited = 0; waited < 30_000; waited += 250) {
        if ((await this.exec("/bin/launchctl", ["print", service])).code !== 0) break;
        await this.sleep(250);
      }
    }
    let result = await this.exec("/bin/launchctl", ["bootstrap", this.target(), this.plist]);
    for (let attempt = 1; result.code === 5 && attempt <= 4; attempt++) {
      await this.sleep(1000);
      result = await this.exec("/bin/launchctl", ["bootstrap", this.target(), this.plist]);
    }
    if (result.code !== 0)
      throw new Error(
        `launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    return { definition: this.plist };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    await this.exec("/bin/launchctl", ["bootout", `${this.target()}/${LAUNCH_AGENT_LABEL}`]);
    if (!existsSync(this.plist)) return { removed: false };
    // Only remove a plist that is ours.
    if (!readFileSync(this.plist, "utf8").includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)) {
      throw new Error(`${this.plist} does not look like the OCD LaunchAgent; leaving it in place`);
    }
    unlinkSync(this.plist);
    return { removed: true };
  }

  async restart(): Promise<void> {
    // `kickstart -k` sends SIGKILL, which skips the supervisor's graceful
    // shutdown. Ask for SIGTERM, wait for the exit, then start it again.
    const service = `${this.target()}/${LAUNCH_AGENT_LABEL}`;
    const term = await this.exec("/bin/launchctl", ["kill", "SIGTERM", service]);
    if (term.code !== 0) {
      // Not running (kill finds no process) is fine; a missing service is not.
      const printed = await this.exec("/bin/launchctl", ["print", service]);
      if (printed.code !== 0)
        throw new Error(
          `launchctl kickstart failed: ${printed.stderr.trim() || term.stderr.trim() || term.stdout.trim()}`,
        );
    } else {
      const deadline = Date.now() + this.stopTimeoutMs;
      for (;;) {
        const printed = await this.exec("/bin/launchctl", ["print", service]);
        if (printed.code !== 0 || !/^\s*pid = \d+$/m.test(printed.stdout)) break;
        if (Date.now() >= deadline)
          throw new Error(
            `the supervisor did not exit within ${Math.round(this.stopTimeoutMs / 1000)}s of SIGTERM; not killing it (workers may still be shutting down)`,
          );
        await this.sleep(500);
      }
    }
    // Without -k: start it if launchd has not already (KeepAlive does not restart a clean exit).
    const result = await this.exec("/bin/launchctl", ["kickstart", service]);
    if (result.code !== 0)
      throw new Error(
        `launchctl kickstart failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  }

  async status(): Promise<ServiceStatus> {
    const result = await this.exec("/bin/launchctl", [
      "print",
      `${this.target()}/${LAUNCH_AGENT_LABEL}`,
    ]);
    const field = (name: string) =>
      new RegExp(`^\\s*${name} = (.+)$`, "m").exec(result.stdout)?.[1]?.trim() ?? null;
    const pid = field("pid");
    return {
      manager: "launchd",
      installed: existsSync(this.plist),
      loaded: result.code === 0,
      state: result.code === 0 ? field("state") : null,
      pid: pid ? Number(pid) : null,
      lastExitCode: result.code === 0 ? field("last exit code") : null,
      definition: this.plist,
    };
  }
}
