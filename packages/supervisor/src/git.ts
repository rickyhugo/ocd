import { execFile, spawn } from "node:child_process";

import { systemScheduler } from "@ocd/core";

import { filteredEnv } from "./env.ts";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * The one way the supervisor runs git. Everything that touches a repository
 * (workspaces, branch sync, self-update) takes a `GitRunner`, so tests can
 * script failures that a real repository cannot produce on demand.
 */
export interface GitRunner {
  /**
   * Runs `git <args>`; resolves (never rejects) with git's exit status. By
   * default git sees a filtered environment; pass `env` for the user's
   * credentials. `timeoutMs` defaults to 60 seconds.
   */
  run(
    args: string[],
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ExecResult>;

  /**
   * Runs git and keeps at most `maxBytes` of stdout; once over, the process is
   * killed and `overflow` is set, so a huge diff never lands in memory whole.
   * `code` is git's exit status (null when killed or not started).
   */
  capped(
    args: string[],
    options: { cwd: string; maxBytes: number; timeoutMs?: number },
  ): Promise<{ stdout: Buffer; overflow: boolean; code: number | null }>;
}

/** Runs the `git` found on PATH. */
export const systemGit: GitRunner = {
  run(args, options) {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: options.cwd,
          env: options.env ?? { ...filteredEnv(), GIT_TERMINAL_PROMPT: "0" },
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const err = error as
            | (NodeJS.ErrnoException & { code?: number | string; killed?: boolean })
            | null;
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : null) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: Boolean(err?.killed),
          });
        },
      );
    });
  },

  capped(args, { cwd, maxBytes, timeoutMs = 60_000 }) {
    return new Promise((resolve) => {
      const child = spawn("git", args, {
        cwd,
        env: { ...filteredEnv(), GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      const timer = systemScheduler.setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (overflow) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      const done = (code: number | null) => {
        systemScheduler.clearTimeout(timer);
        resolve({ stdout: Buffer.concat(chunks), overflow, code });
      };
      child.on("error", () => done(null));
      child.on("close", (code) => done(code));
    });
  },
};

/** Runs git and returns its stdout (trimmed unless `trim: false`); throws when git fails. */
export async function gitText(
  git: GitRunner,
  cwd: string,
  args: string[],
  options: { trim?: boolean } = {},
): Promise<string> {
  const result = await git.run(args, { cwd });
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return options.trim === false ? result.stdout : result.stdout.trim();
}

/** Splits NUL-separated git output (`-z`) into its non-empty fields. */
export function nulFields(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * Paths from `git status --porcelain=v1 -z`. Each entry is "XY path"; renames
 * and copies are followed by the original path as a separate entry. Never trim
 * this output: the status column may start with a space.
 */
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return paths;
}
