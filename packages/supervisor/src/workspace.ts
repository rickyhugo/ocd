import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Repository, Verification } from "@ocd/core";
import { truncate } from "@ocd/core";

import { ApiError } from "./errors.ts";

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
];

/** Only selected variables reach worker and verification processes; unrelated credentials are not inherited. */
export function filteredEnv(
  allowlist: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASE_ENV_KEYS, ...allowlist]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(
  cmd: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
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
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd });
  if (result.code !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result.stdout.trim();
}

export class WorkspaceError extends ApiError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export interface Workspace {
  path: string;
  branch: string;
  baseRef: string;
}

/** One managed git worktree per editing task. Never deletes anything. */
export class WorkspaceManager {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Canonicalizes and validates a repository path before it joins the allowlist. */
  async canonicalRepoPath(path: string): Promise<string> {
    if (!existsSync(path)) throw new ApiError(400, "repo_missing", `${path} does not exist`);
    const real = realpathSync(path);
    let top: string;
    try {
      top = realpathSync(await git(real, ["rev-parse", "--show-toplevel"]));
    } catch {
      throw new ApiError(400, "not_a_repo", `${real} is not a git repository`);
    }
    if (top !== real)
      throw new ApiError(400, "not_repo_root", `${real} is not the repository root (${top})`);
    const rootReal = existsSync(this.root) ? realpathSync(this.root) : this.root;
    if (real === rootReal || real.startsWith(rootReal + sep)) {
      throw new ApiError(
        400,
        "repo_in_workspaces",
        "Managed workspaces cannot be registered as repositories",
      );
    }
    return real;
  }

  pathFor(repoName: string, taskId: string): string {
    return join(this.root, repoName, taskId);
  }

  branchFor(taskId: string): string {
    return `ocd/${taskId}`;
  }

  /**
   * Creates the task's worktree, or reuses it when it already belongs to this
   * task. Anything else at the path or branch is a collision and is refused.
   */
  async ensure(
    repo: Repository,
    taskId: string,
    recordedBaseRef: string | null,
  ): Promise<Workspace> {
    const repoPath = await this.canonicalRepoPath(repo.path);
    if (repoPath !== repo.path) {
      throw new WorkspaceError(
        "repo_moved",
        `Repository ${repo.name} now resolves to ${repoPath}, not ${repo.path}`,
      );
    }
    const path = this.pathFor(repo.name, taskId);
    const branch = this.branchFor(taskId);
    const worktrees = await this.worktrees(repoPath);
    const registered = worktrees.find(
      (w) => w.path === path || (existsSync(path) && w.path === realpathSync(path)),
    );
    if (registered) {
      if (registered.branch !== `refs/heads/${branch}`) {
        throw new WorkspaceError(
          "workspace_collision",
          `${path} is a worktree for ${registered.branch ?? "a detached HEAD"}, not ${branch}`,
        );
      }
      const baseRef = recordedBaseRef ?? (await git(repoPath, ["merge-base", "HEAD", branch]));
      return { path, branch, baseRef };
    }
    if (existsSync(path))
      throw new WorkspaceError(
        "workspace_collision",
        `${path} exists but is not this task's worktree`,
      );
    const branchInUse = worktrees.find((w) => w.branch === `refs/heads/${branch}`);
    if (branchInUse)
      throw new WorkspaceError(
        "branch_collision",
        `Branch ${branch} is checked out at ${branchInUse.path}`,
      );
    const branchExists =
      (
        await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
          cwd: repoPath,
        })
      ).code === 0;
    if (branchExists)
      throw new WorkspaceError(
        "branch_collision",
        `Branch ${branch} already exists; refusing to reuse it`,
      );
    const baseRef =
      recordedBaseRef ??
      (await git(repoPath, ["rev-parse", "--verify", `${repo.baseRef ?? "HEAD"}^{commit}`]));
    await git(repoPath, ["worktree", "add", "-b", branch, path, baseRef]);
    return { path: realpathSync(path), branch, baseRef };
  }

  private async worktrees(repoPath: string): Promise<{ path: string; branch: string | null }[]> {
    const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
    const result: { path: string; branch: string | null }[] = [];
    for (const block of out.split("\n\n")) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      if (!path) continue;
      const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? null;
      result.push({ path: existsSync(path) ? realpathSync(path) : path, branch });
    }
    return result;
  }

  /** Independent facts about the workspace, separate from the worker's claims. */
  async verify(
    workspace: { path: string; baseRef: string },
    options: { command?: string[] | null; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<Verification> {
    const status = await git(workspace.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const dirtyFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").at(-1)!);
    const committed = (
      await git(workspace.path, ["diff", "--name-only", `${workspace.baseRef}...HEAD`])
    )
      .split("\n")
      .filter(Boolean);
    const commitsAhead = Number(
      await git(workspace.path, ["rev-list", "--count", `${workspace.baseRef}..HEAD`]),
    );
    let command: Verification["command"] = null;
    if (options.command?.length) {
      const [cmd, ...args] = options.command;
      const result = await run(cmd!, args, {
        cwd: workspace.path,
        env: options.env ?? filteredEnv(),
        timeoutMs: options.timeoutMs ?? 600_000,
      });
      command = {
        argv: options.command,
        exitCode: result.code,
        timedOut: result.timedOut,
        outputTail: truncate((result.stdout + result.stderr).slice(-4000), 4000),
      };
    }
    return {
      changedFiles: [...new Set([...committed, ...dirtyFiles])].sort(),
      dirty: dirtyFiles.length > 0,
      commitsAhead,
      command,
    };
  }

  relative(path: string): string {
    return relative(this.root, path);
  }
}
