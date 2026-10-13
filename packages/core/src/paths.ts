import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OcdPaths {
  home: string;
  db: string;
  config: string;
  runDir: string;
  socket: string;
  lock: string;
  logs: string;
  workspaces: string;
  backups: string;
}

// sockaddr_un.sun_path is 104 bytes on macOS, including the terminator.
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
    backups: join(home, "backups"),
  };
}
