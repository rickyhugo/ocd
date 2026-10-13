import { execFile } from "node:child_process";

export interface PullRequestInput {
  /** Directory inside the repository (a worktree is fine). */
  cwd: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export type MergeMethod = "squash" | "merge" | "rebase";

export interface PullRequestStatus {
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** GitHub's view: conflicts, branch protection, review requirements. */
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** BLOCKED, BEHIND, CLEAN, DIRTY, UNSTABLE, ... as reported by GitHub. */
  mergeState: string;
  failingChecks: string[];
  pendingChecks: string[];
}

/**
 * Opens, inspects, and merges pull requests. Only ever used on an explicit
 * human request, or the manager acting on one.
 */
export interface PullRequestHost {
  create(input: PullRequestInput): Promise<{ url: string }>;
  status(url: string, cwd: string): Promise<PullRequestStatus>;
  merge(url: string, cwd: string, method: MergeMethod): Promise<void>;
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

function gh(binary: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { cwd, env: process.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `gh ${args.slice(0, 2).join(" ")} failed: ${String(stderr || stdout || error).trim()}`,
            ),
          );
        else resolve(String(stdout));
      },
    );
    child.stdin?.end(input ?? "");
  });
}

/** GitHub via the `gh` CLI, using the user's own `gh auth` login. */
export class GhPullRequests implements PullRequestHost {
  private readonly binary: string;

  constructor(binary = "gh") {
    this.binary = binary;
  }

  async create(input: PullRequestInput): Promise<{ url: string }> {
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
    const stdout = await gh(this.binary, args, input.cwd, input.body);
    const url = /https?:\/\/\S+/.exec(stdout)?.[0];
    if (!url) throw new Error(`gh pr create printed no URL: ${stdout.trim()}`);
    return { url };
  }

  async status(url: string, cwd: string): Promise<PullRequestStatus> {
    const raw = JSON.parse(
      await gh(
        this.binary,
        ["pr", "view", url, "--json", "state,isDraft,mergeable,mergeStateStatus,statusCheckRollup"],
        cwd,
      ),
    ) as {
      state: string;
      isDraft: boolean;
      mergeable: string;
      mergeStateStatus: string;
      statusCheckRollup: CheckEntry[] | null;
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
    };
  }

  async merge(url: string, cwd: string, method: MergeMethod): Promise<void> {
    // No --admin (never bypass protection) and no --delete-branch (OCD removes
    // the worktree and branches itself once GitHub reports the merge).
    await gh(this.binary, ["pr", "merge", url, `--${method}`], cwd);
  }
}

export class RecordingPullRequests implements PullRequestHost {
  readonly created: PullRequestInput[] = [];
  readonly merged: { url: string; method: MergeMethod }[] = [];
  /** Status to report per URL; defaults to an open, clean, green PR. */
  readonly statuses = new Map<string, Partial<PullRequestStatus>>();

  async create(input: PullRequestInput): Promise<{ url: string }> {
    this.created.push(input);
    return { url: `https://example.test/pr/${this.created.length}` };
  }

  async status(url: string): Promise<PullRequestStatus> {
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

  async merge(url: string, _cwd: string, method: MergeMethod): Promise<void> {
    this.merged.push({ url, method });
  }
}
