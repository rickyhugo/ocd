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

/** Opens pull requests. Only ever called on an explicit human or manager request. */
export interface PullRequestCreator {
  create(input: PullRequestInput): Promise<{ url: string }>;
}

/** GitHub via the `gh` CLI, using the user's own `gh auth` login. */
export class GhPullRequests implements PullRequestCreator {
  private readonly binary: string;

  constructor(binary = "gh") {
    this.binary = binary;
  }

  create(input: PullRequestInput): Promise<{ url: string }> {
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
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binary,
        args,
        { cwd: input.cwd, env: process.env, timeout: 120_000 },
        (error, stdout, stderr) => {
          const url = /https?:\/\/\S+/.exec(String(stdout))?.[0];
          if (error || !url)
            reject(new Error(`gh pr create failed: ${String(stderr || stdout || error).trim()}`));
          else resolve({ url });
        },
      );
      child.stdin?.end(input.body);
    });
  }
}

export class RecordingPullRequests implements PullRequestCreator {
  readonly created: PullRequestInput[] = [];

  async create(input: PullRequestInput): Promise<{ url: string }> {
    this.created.push(input);
    return { url: `https://example.test/pr/${this.created.length}` };
  }
}
