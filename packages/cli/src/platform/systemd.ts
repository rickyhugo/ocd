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

// systemd user unit for the supervisor (Linux). Like launchd, systemd user
// services get a minimal environment, so paths are absolute.

export const SYSTEMD_UNIT = "ocd-supervisor.service";
const MARKER = "# Managed by ocd (ocd service install)";

export function unitPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  return join(config, "systemd", "user", SYSTEMD_UNIT);
}

/**
 * One systemd word: double-quoted, with backslash, quote and specifier (%)
 * escapes. `$` is escaped as `$$` only where systemd expands variables
 * (ExecStart= words); Environment= values do no variable expansion, so there
 * `$$` would stay literal.
 */
export function systemdQuote(value: string, options: { expandVariables?: boolean } = {}): string {
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (options.expandVariables ?? true) escaped = escaped.replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/** A path used unquoted after `append:`; only specifiers are expanded there. */
function systemdPath(value: string): string {
  return value.replaceAll("%", "%%");
}

export function renderUnit(spec: ServiceSpec): string {
  const env = Object.entries(serviceEnv(spec, servicePath(spec.nodePath, "linux")))
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`, { expandVariables: false })}`)
    .join("\n");
  const exec = [spec.nodePath, spec.cliPath, "daemon", "--background"]
    .map((w) => systemdQuote(w))
    .join(" ");
  return `${MARKER}
[Unit]
Description=OCD supervisor (local agent control plane)

[Service]
Type=simple
ExecStart=${exec}
${env}
# Restart after a crash, not after a clean \`ocd stop\`.
Restart=on-failure
RestartSec=10
StandardOutput=append:${systemdPath(join(spec.logsDir, "service.out.log"))}
StandardError=append:${systemdPath(join(spec.logsDir, "service.err.log"))}

[Install]
WantedBy=default.target
`;
}

export class SystemdService implements ServiceManager {
  readonly kind = "systemd";
  private readonly exec: Exec;
  private readonly unit: string;
  private readonly systemctl: string;

  constructor(options: { exec?: Exec; unit?: string; systemctl?: string } = {}) {
    this.exec = options.exec ?? execCommand;
    this.unit = options.unit ?? unitPath();
    this.systemctl = options.systemctl ?? "systemctl";
  }

  private async ctl(...args: string[]) {
    const result = await this.exec(this.systemctl, ["--user", ...args]);
    if (result.code !== 0)
      throw new Error(
        `systemctl --user ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    return result;
  }

  async install(spec: ServiceSpec): Promise<{ definition: string }> {
    mkdirSync(dirname(this.unit), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.unit) && !readFileSync(this.unit, "utf8").startsWith(MARKER)) {
      throw new Error(`${this.unit} was not written by ocd; leaving it in place`);
    }
    writeFileSync(this.unit, renderUnit(spec), { mode: 0o644 });
    await this.ctl("daemon-reload");
    await this.ctl("enable", SYSTEMD_UNIT);
    // restart, not start: an updated definition must take effect.
    await this.ctl("restart", SYSTEMD_UNIT);
    return { definition: this.unit };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    if (!existsSync(this.unit)) return { removed: false };
    if (!readFileSync(this.unit, "utf8").startsWith(MARKER)) {
      throw new Error(`${this.unit} was not written by ocd; leaving it in place`);
    }
    await this.exec(this.systemctl, ["--user", "disable", "--now", SYSTEMD_UNIT]);
    unlinkSync(this.unit);
    await this.exec(this.systemctl, ["--user", "daemon-reload"]);
    return { removed: true };
  }

  async restart(): Promise<void> {
    await this.ctl("restart", SYSTEMD_UNIT);
  }

  async status(): Promise<ServiceStatus> {
    const result = await this.exec(this.systemctl, [
      "--user",
      "show",
      SYSTEMD_UNIT,
      "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus",
    ]);
    const props = new Map(
      result.stdout
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()] as const),
    );
    const loaded = result.code === 0 && props.get("LoadState") === "loaded";
    const pid = Number(props.get("MainPID") ?? 0);
    return {
      manager: "systemd",
      installed: existsSync(this.unit),
      loaded,
      state: loaded ? `${props.get("ActiveState")} (${props.get("SubState")})` : null,
      pid: pid > 0 ? pid : null,
      lastExitCode: loaded ? (props.get("ExecMainStatus") ?? null) : null,
      definition: this.unit,
    };
  }
}
