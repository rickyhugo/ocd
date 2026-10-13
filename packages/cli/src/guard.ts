import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";

/**
 * True when this process runs inside one of the live OCD's worktrees without
 * an explicit OCD_HOME: a worker's shell, or a human in a worktree. The live
 * supervisor must not be driven from there; workers get a sandbox OCD_HOME,
 * so this only catches a path that bypassed it.
 */
export function insideWorktree(
  cwd: string,
  workspaces: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["OCD_HOME"]) return false;
  if (!existsSync(workspaces)) return false;
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  const dir = real(cwd);
  const root = real(workspaces);
  return dir === root || dir.startsWith(`${root}${sep}`);
}
