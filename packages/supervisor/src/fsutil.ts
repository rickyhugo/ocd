import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";

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
