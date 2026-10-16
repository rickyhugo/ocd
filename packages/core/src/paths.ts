import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface OcdPaths {
  home: string;
  db: string;
  config: string;
  runDir: string;
  socket: string;
  lock: string;
  logs: string;
  workspaces: string;
  /** Per-task working directories of tasks dispatched without a workspace. */
  scratch: string;
  backups: string;
  /** API token that authenticates OCD's own clients; lives next to the socket. */
  token: string;
}

/**
 * The OCD environment every worker shell gets: a per-task sandbox home, so
 * `ocd` run by a worker (say, while developing OCD itself) never reaches the
 * live supervisor or its API token. `ocd daemon` there starts an isolated one.
 */
export function workerOcdEnv(sandboxHome: string): Record<string, string> {
  return {
    OCD_HOME: sandboxHome,
    OCD_SOCKET: join(sandboxHome, "run", "ocd.sock"),
    OCD_CONFIG: join(sandboxHome, "ocd.jsonc"),
  };
}

/** The API token of the supervisor listening on `socketPath`. */
export function apiTokenPath(socketPath: string): string {
  return join(dirname(socketPath), "api.token");
}

// sockaddr_un.sun_path is at most 104 bytes on the supported systems, including the terminator.
const MAX_SOCKET_PATH_BYTES = 103;

export function resolveOcdPaths(env: NodeJS.ProcessEnv = process.env): OcdPaths {
  const home = resolve(env["OCD_HOME"] ?? join(homedir(), ".ocd"));
  const runDir = join(home, "run");
  const socket = resolve(env["OCD_SOCKET"] ?? join(runDir, "ocd.sock"));
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Socket path is too long for a Unix socket (${Buffer.byteLength(socket)} bytes): ${socket}. ` +
        "Set OCD_SOCKET to a shorter path.",
    );
  }
  return {
    home,
    db: join(home, "ocd.db"),
    // Declarative config (settings and profiles); may be a symlink into a git repo.
    config: resolve(env["OCD_CONFIG"] ?? join(home, "ocd.jsonc")),
    runDir,
    socket,
    lock: join(runDir, "supervisor.lock"),
    logs: join(home, "logs"),
    workspaces: join(home, "workspaces"),
    scratch: join(home, "scratch"),
    backups: join(home, "backups"),
    token: apiTokenPath(socket),
  };
}
