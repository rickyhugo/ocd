import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Why `ocd service install|uninstall` and `ocd restart` must not run here, or
 * null. The background service is global (one per user), so these commands
 * may only act from the home the service is (or would be) defined for: the
 * default home, or the one the installed definition points at. A worker's
 * sandbox home (see workerOcdEnv) is never allowed: it would kickstart,
 * remove or rewrite the live service.
 */
export function serviceHomeProblem(options: {
  env?: NodeJS.ProcessEnv;
  defaultHome: string;
  /** Text of the installed plist / unit, when there is one. */
  definition?: string | null;
}): string | null {
  const env = options.env ?? process.env;
  const defaultHome = resolve(options.defaultHome);
  const home = resolve(env["OCD_HOME"] || defaultHome);
  if (home === defaultHome) return null;
  if (home.startsWith(`${join(defaultHome, "sandbox")}${sep}`))
    return `this shell is inside a worker sandbox (OCD_HOME=${home}); the background service belongs to the live OCD at ${defaultHome} and cannot be changed from here`;
  const h = escapeRegExp(home);
  const definition = options.definition ?? "";
  const pointsHere =
    new RegExp(`OCD_HOME=${h}"`).test(definition) ||
    new RegExp(`<key>OCD_HOME</key>\\s*<string>${h}</string>`).test(
      definition.replaceAll("&amp;", "&"),
    );
  if (pointsHere) return null;
  return `OCD_HOME=${home} is not the home of the background service (${defaultHome} by default); the service is global, so it is only managed from its own home. Unset OCD_HOME, or run \`ocd daemon\` for a scratch home`;
}
