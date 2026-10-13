/** What a background-service definition runs: the pinned Node and the built CLI. */
export interface ServiceSpec {
  /** Absolute path of the Node binary that runs the CLI (pinned version). */
  nodePath: string;
  /** Absolute path of the built `ocd.mjs`. */
  cliPath: string;
  logsDir: string;
  /** Forwarded so the service uses the same state and config as this shell. */
  env: { OCD_HOME?: string | undefined; OCD_CONFIG?: string | undefined };
}

export interface ServiceStatus {
  manager: "launchd" | "systemd";
  /** The definition file exists. */
  installed: boolean;
  /** The service manager knows the service. */
  loaded: boolean;
  state: string | null;
  pid: number | null;
  lastExitCode: string | null;
  definition: string;
}

/**
 * Runs the supervisor in the background and at login: a LaunchAgent on macOS,
 * a systemd user unit on Linux. Both restart after a crash, not after a clean
 * `ocd stop`.
 */
export interface ServiceManager {
  readonly kind: "launchd" | "systemd";
  install(spec: ServiceSpec): Promise<{ definition: string }>;
  uninstall(): Promise<{ removed: boolean }>;
  /** Stops the running supervisor (SIGTERM, a graceful shutdown) and starts it again. */
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export function serviceEnv(spec: ServiceSpec, path: string): Record<string, string> {
  const env: Record<string, string> = { PATH: path };
  if (spec.env.OCD_HOME) env["OCD_HOME"] = spec.env.OCD_HOME;
  if (spec.env.OCD_CONFIG) env["OCD_CONFIG"] = spec.env.OCD_CONFIG;
  return env;
}
