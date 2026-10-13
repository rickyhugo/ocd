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

  constructor(options: { exec?: Exec; plist?: string } = {}) {
    this.exec = options.exec ?? execCommand;
    this.plist = options.plist ?? plistPath();
  }

  private target(): string {
    if (typeof process.getuid !== "function") throw new Error("launchd needs a POSIX user id");
    return `gui/${process.getuid()}`;
  }

  async install(spec: ServiceSpec): Promise<{ definition: string }> {
    mkdirSync(dirname(this.plist), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true, mode: 0o700 });
    // Replace an older definition if one is loaded; a missing one is fine.
    await this.exec("/bin/launchctl", ["bootout", `${this.target()}/${LAUNCH_AGENT_LABEL}`]);
    writeFileSync(this.plist, renderPlist(spec), { mode: 0o644 });
    const result = await this.exec("/bin/launchctl", ["bootstrap", this.target(), this.plist]);
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
    // -k: kill the running instance first; launchd starts it again right away.
    const result = await this.exec("/bin/launchctl", [
      "kickstart",
      "-k",
      `${this.target()}/${LAUNCH_AGENT_LABEL}`,
    ]);
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
