import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Creates a directory with mode 0700 and refuses directories owned by someone else. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = statSync(path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${path} is not owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/**
 * The API token that OCD's own clients (CLI, TUI, manager plugin) present.
 * Created once with mode 0600 and kept across restarts, so running clients
 * keep working; workers never get it (see the worker sandbox environment).
 */
export function ensureApiToken(path: string): string {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Refusing to use ${path} as the API token: not a file`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error(`${path} is not owned by the current user`);
    if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o600);
    const token = readFileSync(path, "utf8").trim();
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/**
 * Removes a stale socket file. Only call while holding the supervisor lock: the
 * lock proves no other daemon owns it. Refuses anything that is not our socket.
 */
export function removeStaleSocket(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isSocket()) throw new Error(`Refusing to remove ${path}: not a socket`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing to remove ${path}: owned by another user`);
  }
  unlinkSync(path);
  return true;
}
