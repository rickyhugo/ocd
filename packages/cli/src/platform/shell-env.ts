import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, isAbsolute } from "node:path";

import { commonBinDirs } from "./exec.ts";

// A service manager (launchd, systemd) starts the supervisor with a bare PATH,
// and a notification click starts `ocd focus` with even less. The tools the
// user installed (gh, tmux, git, the harnesses) are on the PATH their login
// shell sets up, however it does that, so the supervisor asks that shell once
// at startup, the way GUI editors do, and runs everything with the result.

const MARK = "__OCD_SHELL_PATH__";
/** Shells known to accept `-l -i -c` and print PATH colon-joined. */
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "mksh"]);
const SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];

export interface LoginShellPath {
  /** PATH as the login shell sets it up; null when it could not be read. */
  path: string | null;
  shell: string | null;
  /** Why the PATH could not be read. */
  error: string | null;
}

/** The user's login shell from the account database, else $SHELL. */
export function userShell(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    // no passwd entry
  }
  return env["SHELL"] || null;
}

/** The PATH printed between the markers; startup noise from rc files is ignored. */
export function parseShellPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  const start = lines.indexOf(MARK);
  const end = lines.indexOf(MARK, start + 1);
  if (start < 0 || end !== start + 2) return null;
  const path = lines[start + 1]!.trim();
  return path.split(delimiter).some((dir) => isAbsolute(dir)) ? path : null;
}

/**
 * Runs the login shell as an interactive login shell (so both profile and rc
 * files run, where version managers and Homebrew add themselves) and reads its
 * PATH. Without a terminal (detached, stdin closed) and bounded by a timeout:
 * a slow or broken shell setup costs at most `timeoutMs` and yields null.
 * `OCD_RESOLVING_SHELL_ENV=1` lets rc files skip anything interactive.
 */
export function loginShellPath(
  options: { shell?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<LoginShellPath> {
  const env = options.env ?? process.env;
  const shell = options.shell === undefined ? userShell(env) : options.shell;
  if (!shell) return Promise.resolve({ path: null, shell: null, error: "no login shell" });
  if (!SHELLS.has(basename(shell)))
    return Promise.resolve({ path: null, shell, error: `unsupported shell ${basename(shell)}` });
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (path: string | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ path, shell, error });
    };
    const child = spawn(
      shell,
      ["-l", "-i", "-c", `printf '%s\\n%s\\n%s\\n' ${MARK} "$PATH" ${MARK}`],
      {
        cwd: homedir(),
        env: { ...env, OCD_RESOLVING_SHELL_ENV: "1" },
        // No controlling terminal: an interactive shell cannot grab or wait on one.
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      done(null, `${basename(shell)} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => done(null, `${shell} could not be started: ${error.message}`));
    child.on("close", (code) => {
      const path = parseShellPath(stdout);
      done(path, path ? null : `${basename(shell)} printed no PATH (exit ${code ?? "signal"})`);
    });
  });
}

/**
 * The PATH OCD runs tools with: the login shell's (the user's own order), then
 * the inherited one, then common install locations and the system directories
 * as a fallback when the shell could not be read. Relative entries and
 * duplicates are dropped.
 */
export function toolPath(options: {
  login?: string | null;
  inherited?: string | undefined;
  platform?: NodeJS.Platform;
  home?: string;
}): string {
  const dirs = [
    ...(options.login ?? "").split(delimiter),
    ...(options.inherited ?? "").split(delimiter),
    ...commonBinDirs(options.platform, options.home),
    ...SYSTEM_DIRS,
  ].filter((dir) => isAbsolute(dir));
  return [...new Set(dirs)].join(delimiter);
}
