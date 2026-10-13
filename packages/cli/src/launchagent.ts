import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// User LaunchAgent for the supervisor. launchd does not inherit an
// interactive shell's PATH or mise activation, so everything is absolute.

export const LAUNCH_AGENT_LABEL = "dev.ocd.supervisor";

export interface LaunchAgentSpec {
  /** Absolute path of the Node binary that runs the CLI (pinned version). */
  nodePath: string;
  /** Absolute path of the built `ocd.mjs`. */
  cliPath: string;
  logsDir: string;
  /** Forwarded so the agent uses the same state and config as this shell. */
  env: { OCD_HOME?: string | undefined; OCD_CONFIG?: string | undefined };
}

export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execCommand: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

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

export function renderPlist(spec: LaunchAgentSpec): string {
  const path = [
    dirname(spec.nodePath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const env: Record<string, string> = { PATH: path };
  if (spec.env.OCD_HOME) env["OCD_HOME"] = spec.env.OCD_HOME;
  if (spec.env.OCD_CONFIG) env["OCD_CONFIG"] = spec.env.OCD_CONFIG;
  const envXml = Object.entries(env)
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

function domain(): string {
  if (typeof process.getuid !== "function")
    throw new Error("LaunchAgents are only supported on macOS");
  return `gui/${process.getuid()}`;
}

export async function installLaunchAgent(
  spec: LaunchAgentSpec,
  options: { exec?: Exec; plist?: string } = {},
): Promise<{ plist: string }> {
  const exec = options.exec ?? execCommand;
  const plist = options.plist ?? plistPath();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(spec.logsDir, { recursive: true, mode: 0o700 });
  // Replace an older definition if one is loaded; a missing one is fine.
  await exec("/bin/launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  writeFileSync(plist, renderPlist(spec), { mode: 0o644 });
  const result = await exec("/bin/launchctl", ["bootstrap", domain(), plist]);
  if (result.code !== 0)
    throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return { plist };
}

export async function uninstallLaunchAgent(
  options: { exec?: Exec; plist?: string } = {},
): Promise<{ removed: boolean }> {
  const exec = options.exec ?? execCommand;
  const plist = options.plist ?? plistPath();
  await exec("/bin/launchctl", ["bootout", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  if (!existsSync(plist)) return { removed: false };
  // Only remove a plist that is ours.
  if (!readFileSync(plist, "utf8").includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)) {
    throw new Error(`${plist} does not look like the OCD LaunchAgent; leaving it in place`);
  }
  unlinkSync(plist);
  return { removed: true };
}

export interface LaunchAgentStatus {
  installed: boolean;
  loaded: boolean;
  state: string | null;
  pid: number | null;
  lastExitCode: string | null;
  plist: string;
}

export async function launchAgentStatus(
  options: { exec?: Exec; plist?: string } = {},
): Promise<LaunchAgentStatus> {
  const exec = options.exec ?? execCommand;
  const plist = options.plist ?? plistPath();
  const result = await exec("/bin/launchctl", ["print", `${domain()}/${LAUNCH_AGENT_LABEL}`]);
  const field = (name: string) =>
    new RegExp(`^\\s*${name} = (.+)$`, "m").exec(result.stdout)?.[1]?.trim() ?? null;
  const pid = field("pid");
  return {
    installed: existsSync(plist),
    loaded: result.code === 0,
    state: result.code === 0 ? field("state") : null,
    pid: pid ? Number(pid) : null,
    lastExitCode: result.code === 0 ? field("last exit code") : null,
    plist,
  };
}
