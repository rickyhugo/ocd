import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Repository, Verification } from "@ocd/core";

import { ApiError } from "./errors.ts";
import { type GitRunner, gitText, nulFields, parsePorcelainZ, systemGit } from "./git.ts";

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

const MAX_UNTRACKED_FILES = 50;

/** "owner/name" of a github.com remote URL (https, ssh or scp-like); null for any other URL. */
export function githubSlug(url: string): string | null {
  const match =
    /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(
      url,
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** One managed git worktree per editing task. Never deletes anything. */
export class WorkspaceManager {
  private readonly root: string;
  private readonly git: GitRunner;

  constructor(root: string, git: GitRunner = systemGit) {
    this.root = root;
    this.git = git;
  }

  private text(cwd: string, args: string[], options?: { trim?: boolean }): Promise<string> {
    return gitText(this.git, cwd, args, options);
  }

  /** Canonicalizes and validates a repository path before it joins the allowlist. */
  async canonicalRepoPath(path: string): Promise<string> {
    if (!existsSync(path)) throw new ApiError(400, "repo_missing", `${path} does not exist`);
    const real = realpathSync(path);
    let top: string;
    try {
      top = realpathSync(await this.text(real, ["rev-parse", "--show-toplevel"]));
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
      const baseRef =
        recordedBaseRef ?? (await this.text(repoPath, ["merge-base", "HEAD", branch]));
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
        await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
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
      (await this.text(repoPath, ["rev-parse", "--verify", `${repo.baseRef ?? "HEAD"}^{commit}`]));
    await this.text(repoPath, ["worktree", "add", "-b", branch, path, baseRef]);
    return { path: realpathSync(path), branch, baseRef };
  }

  private async worktrees(repoPath: string): Promise<{ path: string; branch: string | null }[]> {
    const out = await this.text(repoPath, ["worktree", "list", "--porcelain"]);
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
  async verify(workspace: { path: string; baseRef: string }): Promise<Verification> {
    const dirtyFiles = parsePorcelainZ(
      await this.text(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        trim: false,
      }),
    );
    const committed = nulFields(
      await this.text(
        workspace.path,
        ["diff", "--name-only", "-z", `${workspace.baseRef}...HEAD`],
        {
          trim: false,
        },
      ),
    );
    const commitsAhead = Number(
      await this.text(workspace.path, ["rev-list", "--count", `${workspace.baseRef}..HEAD`]),
    );
    return {
      changedFiles: [...new Set([...committed, ...dirtyFiles])].sort(),
      dirty: dirtyFiles.length > 0,
      commitsAhead,
    };
  }

  /**
   * Facts that decide whether a task's worktree and branch can be removed:
   * uncommitted files, and commits on the branch that exist nowhere else
   * (no other local branch or remote-tracking branch contains them).
   */
  async branchSafety(
    repoPath: string,
    workspacePath: string | null,
    branch: string,
  ): Promise<{
    worktreeExists: boolean;
    branchExists: boolean;
    dirtyFiles: string[];
    unmergedCommits: number;
  }> {
    const worktreeExists = workspacePath !== null && existsSync(workspacePath);
    const dirtyFiles = worktreeExists
      ? parsePorcelainZ(
          await this.text(
            workspacePath,
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            {
              trim: false,
            },
          ),
        )
      : [];
    const ref = `refs/heads/${branch}`;
    const branchExists =
      (await this.git.run(["show-ref", "--verify", "--quiet", ref], { cwd: repoPath })).code === 0;
    const unmergedCommits = branchExists
      ? Number(
          await this.text(repoPath, [
            "rev-list",
            "--count",
            ref,
            "--not",
            `--exclude=${branch}`, // --exclude matches short names (ocd/<task>)
            "--branches",
            "--remotes",
          ]),
        )
      : 0;
    return { worktreeExists, branchExists, dirtyFiles, unmergedCommits };
  }

  /** Removes a task's worktree and branch. Callers check branchSafety first. */
  async remove(
    repoPath: string,
    workspacePath: string | null,
    branch: string,
    force: boolean,
  ): Promise<void> {
    if (workspacePath) {
      // A missing directory with a leftover admin entry is removed by path too,
      // which leaves the user's other worktrees alone (unlike a repo-wide prune).
      const registered =
        existsSync(workspacePath) ||
        (await this.worktrees(repoPath)).some((w) => w.path === workspacePath);
      if (registered) {
        await this.text(repoPath, [
          "worktree",
          "remove",
          ...(force ? ["--force"] : []),
          workspacePath,
        ]);
      }
    }
    const ref = `refs/heads/${branch}`;
    const exists = async () =>
      (await this.git.run(["show-ref", "--verify", "--quiet", ref], { cwd: repoPath })).code === 0;
    if (await exists()) {
      // Callers have checked safety; `-d` would still refuse commits that only
      // live on a remote-tracking or other branch.
      try {
        await this.text(repoPath, ["branch", "-D", branch]);
      } catch (error) {
        if (await exists()) throw error;
      }
    }
  }

  /** Commits everything in the worktree (used only when explicitly asked). */
  async commitAll(workspacePath: string, message: string): Promise<boolean> {
    await this.text(workspacePath, ["add", "-A"]);
    const staged =
      (await this.git.run(["diff", "--cached", "--quiet"], { cwd: workspacePath })).code !== 0;
    if (staged) await this.text(workspacePath, ["commit", "-m", message]);
    return staged;
  }

  /** Pushes the task branch with the user's own git credentials (full environment). */
  async push(workspacePath: string, remote: string, branch: string): Promise<void> {
    const result = await this.git.run(["push", "-u", remote, `${branch}:${branch}`], {
      cwd: workspacePath,
      env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000,
    });
    if (result.code !== 0)
      throw new Error(`git push failed: ${(result.stderr || result.stdout).trim()}`);
  }

  /** Deletes a pushed task branch from the remote; false if it was already gone. */
  async deleteRemoteBranch(repoPath: string, remote: string, branch: string): Promise<boolean> {
    const result = await this.git.run(["push", remote, "--delete", branch], {
      cwd: repoPath,
      env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000,
    });
    return result.code === 0;
  }

  /**
   * A worktree's changes since its branch left `baseRef`: committed and
   * uncommitted edits plus new untracked files, as one git-format patch capped
   * at `maxBytes`. Read-only: no index or ref is touched, and external diff
   * drivers and textconv filters are not run.
   */
  async diff(
    path: string,
    baseRef: string,
    maxBytes = 1_500_000,
  ): Promise<{
    mergeBase: string;
    head: string;
    files: {
      path: string;
      status: "added" | "deleted" | "modified";
      additions: number | null;
      deletions: number | null;
      uncommitted: boolean;
    }[];
    patch: string;
    truncated: boolean;
  }> {
    const opts = ["-c", "core.quotePath=false"];
    const plain = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    const mergeBase = await this.text(path, ["merge-base", baseRef, "HEAD"]);
    const head = await this.head(path);
    const [numstat, nameStatus, untrackedZ, dirtyZ] = await Promise.all([
      this.text(path, [...opts, "diff", ...plain, "-z", "--numstat", mergeBase], { trim: false }),
      this.text(path, [...opts, "diff", ...plain, "-z", "--name-status", mergeBase], {
        trim: false,
      }),
      this.text(path, ["ls-files", "--others", "--exclude-standard", "-z"], { trim: false }),
      this.text(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { trim: false }),
    ]);
    const dirty = new Set(parsePorcelainZ(dirtyZ));
    // `-z --name-status` alternates status and path fields (no renames here).
    const status = new Map<string, "added" | "deleted" | "modified">();
    const statusFields = nulFields(nameStatus);
    for (let i = 0; i + 1 < statusFields.length; i += 2) {
      const code = statusFields[i]!;
      status.set(
        statusFields[i + 1]!,
        code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      );
    }
    // `-z --numstat` records are "add\tdel\tpath" separated by NUL.
    const files = nulFields(numstat).map((record) => {
      const [add = "-", del = "-", ...rest] = record.split("\t");
      const file = rest.join("\t");
      return {
        path: file,
        status: status.get(file) ?? ("modified" as const),
        additions: add === "-" ? null : Number(add),
        deletions: del === "-" ? null : Number(del),
        uncommitted: dirty.has(file),
      };
    });
    const tracked = await this.git.capped([...opts, "diff", ...plain, mergeBase], {
      cwd: path,
      maxBytes: maxBytes + 1,
      timeoutMs: 120_000,
    });
    const parts: Buffer[] = [tracked.stdout];
    let size = tracked.stdout.length;
    let truncated = tracked.overflow;
    const untracked = nulFields(untrackedZ);
    if (untracked.length > MAX_UNTRACKED_FILES) truncated = true;
    for (const file of untracked.slice(0, MAX_UNTRACKED_FILES)) {
      // `git diff --no-index` exits 1 when the files differ, which they always do here.
      const r = await this.git.run(
        [...opts, "diff", ...plain, "--no-index", "--numstat", "--", "/dev/null", file],
        { cwd: path },
      );
      const [add = "-", del = "-"] = r.stdout.trim().split("\t");
      files.push({
        path: file,
        status: "added",
        additions: add === "-" ? null : Number(add),
        deletions: del === "-" ? null : Number(del),
        uncommitted: true,
      });
      if (size > maxBytes) continue;
      const diff = await this.git.capped(
        [...opts, "diff", ...plain, "--no-index", "--", "/dev/null", file],
        { cwd: path, maxBytes: maxBytes + 1 - size },
      );
      parts.push(diff.stdout);
      size += diff.stdout.length;
      if (diff.overflow) truncated = true;
    }
    // Byte order, as git lists paths.
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let buf = Buffer.concat(parts);
    if (buf.length > maxBytes) {
      truncated = true;
      // Prefer a file boundary, else a line boundary; both are UTF-8 safe cuts.
      const window = buf.subarray(0, maxBytes);
      const file = window.lastIndexOf("\ndiff --git ");
      const line = window.lastIndexOf("\n");
      buf = window.subarray(0, file >= 0 ? file + 1 : line >= 0 ? line + 1 : 0);
    }
    const patch = buf.toString("utf8");
    return { mergeBase, head, files, patch, truncated };
  }

  /** The commit a worktree's HEAD points at. */
  async head(path: string): Promise<string> {
    return this.text(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  }

  /** Files that differ between `from` and HEAD's changes since their merge base. */
  async filesChangedSince(path: string, from: string): Promise<string[]> {
    return nulFields(
      await this.text(path, ["diff", "--name-only", "-z", `${from}...HEAD`], { trim: false }),
    );
  }

  /** Fetches one branch of the remote with the user's credentials; false when it fails. */
  async fetchBranch(path: string, remote: string, branch: string): Promise<boolean> {
    const result = await this.git.run(["fetch", "--quiet", remote, branch], {
      cwd: path,
      env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000,
    });
    return result.code === 0;
  }

  /** Commits in `from..to`, oldest first; merge commits are flagged. */
  async commitsBetween(
    path: string,
    from: string,
    to: string,
  ): Promise<{ sha: string; subject: string; merge: boolean }[]> {
    const out = await this.text(path, [
      "log",
      "--reverse",
      "--format=%H%x09%P%x09%s",
      `${from}..${to}`,
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", parents = "", ...subject] = line.split("\t");
        return { sha, subject: subject.join("\t"), merge: parents.split(" ").length > 1 };
      });
  }

  /**
   * The tree of merging `theirs` into `ours` (with an optional explicit merge
   * base), computed in the object database: no working tree or index is
   * touched. Null when the merge conflicts.
   */
  private async mergeTree(
    path: string,
    ours: string,
    theirs: string,
    mergeBase?: string,
  ): Promise<string | null> {
    const result = await this.git.run(
      [
        "merge-tree",
        "--write-tree",
        ...(mergeBase ? [`--merge-base=${mergeBase}`] : []),
        ours,
        theirs,
      ],
      { cwd: path },
    );
    if (result.code === 1) return null;
    if (result.code !== 0)
      throw new Error(
        `git merge-tree failed (git 2.40 or newer is needed): ${(result.stderr || result.stdout).trim()}`,
      );
    return result.stdout.split("\n")[0]!.trim();
  }

  /**
   * Builds the commit that lands `head` on top of `onto` the way `method`
   * says, without touching the worktree or any branch: squash makes one commit
   * with `message`, merge a merge commit, rebase replays each commit (keeping
   * its author) or reuses `head` when it already sits on `onto`. Throws
   * `land_conflict` when the work no longer applies cleanly.
   */
  async landingCommit(
    path: string,
    options: { onto: string; head: string; method: "squash" | "merge" | "rebase"; message: string },
  ): Promise<string> {
    const { onto, head, method } = options;
    const conflict = () =>
      new WorkspaceError(
        "land_conflict",
        `The task's changes conflict with the current ${onto}; bring the branch up to date first`,
      );
    const nothingToPush = () =>
      new WorkspaceError("nothing_to_push", `The task's changes are already in ${onto}`);
    const commitTree = async (tree: string, parents: string[], message: string, env = {}) => {
      const result = await this.git.run(
        ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message],
        { cwd: path, env: { ...(process.env as Record<string, string>), ...env } },
      );
      if (result.code !== 0)
        throw new Error(`git commit-tree failed: ${(result.stderr || result.stdout).trim()}`);
      return result.stdout.trim();
    };
    if (method !== "rebase") {
      const tree = await this.mergeTree(path, onto, head);
      if (!tree) throw conflict();
      if (tree === (await this.text(path, ["rev-parse", "--verify", `${onto}^{tree}`])))
        throw nothingToPush();
      return commitTree(tree, method === "squash" ? [onto] : [onto, head], options.message);
    }
    const ontoSha = await this.text(path, ["rev-parse", "--verify", `${onto}^{commit}`]);
    const isAncestor =
      (await this.git.run(["merge-base", "--is-ancestor", ontoSha, head], { cwd: path })).code ===
      0;
    if (isAncestor) {
      const headSha = await this.text(path, ["rev-parse", "--verify", `${head}^{commit}`]);
      const sameTree =
        (await this.text(path, ["rev-parse", "--verify", `${head}^{tree}`])) ===
        (await this.text(path, ["rev-parse", "--verify", `${ontoSha}^{tree}`]));
      if (sameTree) throw nothingToPush();
      return headSha;
    }
    const commits = await this.commitsBetween(path, onto, head);
    if (commits.some((c) => c.merge))
      throw new WorkspaceError(
        "land_unsupported",
        "The task branch contains merge commits, which rebase cannot replay; use squash or merge",
      );
    let tip = ontoSha;
    let tipTree = await this.text(path, ["rev-parse", "--verify", `${ontoSha}^{tree}`]);
    for (const commit of commits) {
      const tree = await this.mergeTree(path, tip, commit.sha, `${commit.sha}^`);
      if (!tree) throw conflict();
      if (tree === tipTree) continue; // became empty: already in the target
      const [name, email, date, ...body] = (
        await this.text(path, ["log", "-1", "--format=%an%x00%ae%x00%aI%x00%B", commit.sha], {
          trim: false,
        })
      ).split("\0");
      tip = await commitTree(tree, [tip], body.join("\0").trimEnd(), {
        GIT_AUTHOR_NAME: name ?? "",
        GIT_AUTHOR_EMAIL: email ?? "",
        GIT_AUTHOR_DATE: date ?? "",
      });
      tipTree = tree;
    }
    if (tip === ontoSha) throw nothingToPush();
    return tip;
  }

  /**
   * Pushes `commit` to the remote branch as a fast-forward with the user's
   * credentials. Never forces and never skips hooks; a rejection (the branch
   * moved, branch protection) is reported as `push_rejected`.
   */
  async pushCommit(path: string, remote: string, commit: string, branch: string): Promise<void> {
    const result = await this.git.run(["push", remote, `${commit}:refs/heads/${branch}`], {
      cwd: path,
      env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 300_000,
    });
    if (result.code !== 0)
      throw new WorkspaceError(
        "push_rejected",
        `git push to ${remote}/${branch} was rejected: ${(result.stderr || result.stdout).trim()}`,
      );
  }

  /**
   * True when everything on `branch` is already in one of `bases`: merging the
   * branch into it would change nothing (e.g. after a squash merge on GitHub).
   */
  async landedIn(repoPath: string, branch: string, bases: string[]): Promise<string | null> {
    for (const base of bases) {
      const baseTree = await this.git.run(["rev-parse", "--verify", "--quiet", `${base}^{tree}`], {
        cwd: repoPath,
      });
      if (baseTree.code !== 0) continue;
      const merged = await this.mergeTree(repoPath, base, `refs/heads/${branch}`).catch(() => null);
      if (merged === baseTree.stdout.trim()) return base;
    }
    return null;
  }

  /** The remote's default branch (e.g. main), falling back to "main". */
  /** The GitHub owner/name of the origin remote, or null when origin is missing or not on GitHub. */
  async githubRepo(repoPath: string): Promise<string | null> {
    const result = await this.git.run(["remote", "get-url", "origin"], { cwd: repoPath });
    return result.code === 0 ? githubSlug(result.stdout.trim()) : null;
  }

  async defaultBranch(repoPath: string, remote: string): Promise<string> {
    const result = await this.git.run(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], {
      cwd: repoPath,
    });
    const ref = result.stdout.trim();
    return result.code === 0 && ref.startsWith(`${remote}/`)
      ? ref.slice(remote.length + 1)
      : "main";
  }

  relative(path: string): string {
    return relative(this.root, path);
  }
}
