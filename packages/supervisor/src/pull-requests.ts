import type { GitHubCliStatus, MergeMethod } from "@ocd/core";

import { GhError, probeGh, resolveGh, runGh, safeGhText } from "./github-cli.ts";

export interface PullRequestInput {
  /** Directory inside the repository (a worktree is fine). */
  cwd: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** GitHub's view: conflicts, branch protection, review requirements. */
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** BLOCKED, BEHIND, CLEAN, DIRTY, UNSTABLE, ... as reported by GitHub. */
  mergeState: string;
  failingChecks: string[];
  pendingChecks: string[];
  /** The PR's head commit as GitHub sees it (headRefOid), when known. */
  headSha?: string | undefined;
}

/**
 * Opens, inspects, and merges pull requests. Only ever used on an explicit
 * human request, or the manager acting on one.
 */
export interface PullRequestHost {
  /** existing: an open PR for the branch was found and reused instead of creating one. */
  create(input: PullRequestInput): Promise<{ url: string; existing?: boolean }>;
  status(url: string, cwd: string): Promise<PullRequestStatus>;
  /** With matchHead, GitHub refuses the merge if the PR head moved since it was checked. */
  merge(url: string, cwd: string, method: MergeMethod, matchHead?: string): Promise<void>;
  /** Read-only, bounded availability and login check, run at startup. Never throws. */
  probe?(): Promise<GitHubCliStatus>;
}

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

type CheckEntry = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

/** Splits GitHub's statusCheckRollup into failing and pending check names. */
export function classifyChecks(rollup: CheckEntry[]): { failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const check of rollup) {
    const name = check.name ?? check.context ?? "check";
    if (check.state !== undefined) {
      // Commit status (StatusContext)
      if (check.state === "FAILURE" || check.state === "ERROR") failing.push(name);
      else if (check.state !== "SUCCESS") pending.push(name);
    } else if (check.status !== "COMPLETED") {
      pending.push(name);
    } else if (check.conclusion && FAILED_CONCLUSIONS.has(check.conclusion)) {
      failing.push(name);
    }
  }
  return { failing, pending };
}

export interface GhPullRequestsOptions {
  /** PATH to find gh on; defaults to this process's, read on every call. */
  pathEnv?: string;
  /** Per gh call; a stuck network call fails instead of hanging the task lock. */
  timeoutMs?: number;
}

/** GitHub via the `gh` CLI found on PATH, using the user's own `gh auth` login. */
export class GhPullRequests implements PullRequestHost {
  private readonly options: GhPullRequestsOptions;

  constructor(options: GhPullRequestsOptions = {}) {
    this.options = options;
  }

  /** Looked up on every call: a gh installed after startup needs no restart. */
  private gh(args: string[], cwd: string, input?: string): Promise<string> {
    return runGh(resolveGh({ pathEnv: this.options.pathEnv }), args, {
      cwd,
      ...(input !== undefined ? { input } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
  }

  probe(): Promise<GitHubCliStatus> {
    return probeGh({ pathEnv: this.options.pathEnv, timeoutMs: 10_000 });
  }

  async create(input: PullRequestInput): Promise<{ url: string; existing?: boolean }> {
    // An earlier attempt may have opened the PR before failing (a timeout, a
    // lost response); reuse it rather than opening a second one.
    const open = JSON.parse(
      await this.gh(
        [
          "pr",
          "list",
          "--head",
          input.head,
          "--base",
          input.base,
          "--state",
          "open",
          "--json",
          "url",
          "--limit",
          "1",
        ],
        input.cwd,
      ),
    ) as { url: string }[];
    if (open[0]?.url) return { url: open[0].url, existing: true };
    const args = [
      "pr",
      "create",
      "--head",
      input.head,
      "--base",
      input.base,
      "--title",
      input.title,
      "--body-file",
      "-",
    ];
    if (input.draft) args.push("--draft");
    const stdout = await this.gh(args, input.cwd, input.body);
    const url = /https?:\/\/\S+/.exec(stdout)?.[0];
    if (!url) throw new GhError("failed", `gh pr create printed no URL: ${safeGhText(stdout)}`);
    return { url };
  }

  async status(url: string, cwd: string): Promise<PullRequestStatus> {
    const raw = JSON.parse(
      await this.gh(
        [
          "pr",
          "view",
          url,
          "--json",
          "state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,headRefOid",
        ],
        cwd,
      ),
    ) as {
      state: string;
      isDraft: boolean;
      mergeable: string;
      mergeStateStatus: string;
      statusCheckRollup: CheckEntry[] | null;
      headRefOid?: string | null;
    };
    const { failing, pending } = classifyChecks(raw.statusCheckRollup ?? []);
    return {
      state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
      draft: raw.isDraft,
      mergeable:
        raw.mergeable === "MERGEABLE"
          ? "mergeable"
          : raw.mergeable === "CONFLICTING"
            ? "conflicting"
            : "unknown",
      mergeState: raw.mergeStateStatus,
      failingChecks: failing,
      pendingChecks: pending,
      ...(raw.headRefOid ? { headSha: raw.headRefOid } : {}),
    };
  }

  async merge(url: string, cwd: string, method: MergeMethod, matchHead?: string): Promise<void> {
    // No --admin (never bypass protection) and no --delete-branch (OCD removes
    // the worktree and branches itself once GitHub reports the merge).
    // --match-head-commit binds the merge to the head that was checked.
    await this.gh(
      ["pr", "merge", url, `--${method}`, ...(matchHead ? ["--match-head-commit", matchHead] : [])],
      cwd,
    );
  }
}

export class RecordingPullRequests implements PullRequestHost {
  readonly created: PullRequestInput[] = [];
  readonly merged: { url: string; method: MergeMethod; matchHead?: string | undefined }[] = [];
  /** Status to report per URL; defaults to an open, clean, green PR. */
  readonly statuses = new Map<string, Partial<PullRequestStatus>>();
  /** Open PRs on GitHub by head branch, reused by create. */
  readonly openByHead = new Map<string, string>();
  /** When set, every gh call fails with it (e.g. a GhError). */
  failure: Error | null = null;
  /** What probe reports; a function can hang or throw to test startup. */
  probeResult: GitHubCliStatus | (() => Promise<GitHubCliStatus>) | null = null;

  async create(input: PullRequestInput): Promise<{ url: string; existing?: boolean }> {
    if (this.failure) throw this.failure;
    const existing = this.openByHead.get(input.head);
    if (existing) return { url: existing, existing: true };
    this.created.push(input);
    return { url: `https://example.test/pr/${this.created.length}` };
  }

  async status(url: string): Promise<PullRequestStatus> {
    if (this.failure) throw this.failure;
    const merged = this.merged.some((m) => m.url === url);
    return {
      state: merged ? "merged" : "open",
      draft: false,
      mergeable: "mergeable",
      mergeState: "CLEAN",
      failingChecks: [],
      pendingChecks: [],
      ...this.statuses.get(url),
    };
  }

  async merge(url: string, _cwd: string, method: MergeMethod, matchHead?: string): Promise<void> {
    if (this.failure) throw this.failure;
    this.merged.push({ url, method, ...(matchHead ? { matchHead } : {}) });
  }

  async probe(): Promise<GitHubCliStatus> {
    if (typeof this.probeResult === "function") return this.probeResult();
    return (
      this.probeResult ?? {
        available: true,
        path: "/test/gh",
        version: "0.0.0",
        auth: "ok",
        problem: null,
        problems: [],
        checkedAt: new Date(0).toISOString(),
      }
    );
  }
}
