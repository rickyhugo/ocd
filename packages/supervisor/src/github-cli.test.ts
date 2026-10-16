import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  GhError,
  classifyGhOutput,
  probeGh,
  resolveGh,
  runGh,
  type GhLocation,
} from "./github-cli.ts";
import { GhPullRequests, RecordingPullRequests } from "./pull-requests.ts";
import { declareRepos, makeRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

// A stand-in gh: a /bin/sh script that logs its argv, stdin and environment
// next to itself and behaves according to a `mode` file. No network, no real gh.
const FAKE_GH = `#!/bin/sh
dir=$(dirname "$0")
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo "--"; } >> "$dir/argv.log"
echo "GH_PROMPT_DISABLED=$GH_PROMPT_DISABLED" > "$dir/env.log"
mode=$(cat "$dir/mode" 2>/dev/null)
case "$mode" in
  hang) exec sleep 30 ;;
  auth_missing) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
  network) echo "error connecting to api.github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2; exit 1 ;;
  leak) echo "HTTP 401: Bad credentials (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)" >&2; exit 1 ;;
esac
case "$1 $2" in
  "--version ") echo "gh version 9.9.9 (2026-01-01)"; exit 0 ;;
  "auth status")
    case "$mode" in
      logged_out) echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
      bad_token) printf 'github.com\\n  X Failed to log in to github.com account me (keyring)\\n  - The token in keyring is invalid.\\n' >&2; exit 1 ;;
      offline) printf 'github.com\\n  X Timeout trying to log in to github.com account me (keyring)\\n' >&2; exit 1 ;;
      auth_hang) exec sleep 30 ;;
    esac
    printf 'github.com\\n  ✓ Logged in to github.com account me (keyring)\\n  - Token: gho_************************************\\n'
    exit 0 ;;
  "pr list") cat "$dir/list.json" 2>/dev/null || echo "[]" ;;
  "pr create") cat > "$dir/body.txt"; echo "https://github.com/o/r/pull/7" ;;
  "pr view") cat "$dir/view.json" ;;
  "pr merge") exit 0 ;;
  *) echo "unknown command $1 $2" >&2; exit 1 ;;
esac
`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocd-gh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Installs the fake gh at <dir>/gh and returns its path. */
function fakeGh(dir = join(root, "bin"), mode?: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "gh");
  writeFileSync(path, FAKE_GH, { mode: 0o755 });
  if (mode) writeFileSync(join(dir, "mode"), mode);
  return path;
}

function setMode(gh: string, mode: string): void {
  writeFileSync(join(gh, "..", "mode"), mode);
}

/** Each gh invocation's argv, in order. */
function calls(gh: string): string[][] {
  const log = join(gh, "..", "argv.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--\n")
    .filter(Boolean)
    .map((c) => c.split("\n").filter((_, i, a) => i < a.length - 1));
}

const caught = async (p: Promise<unknown>): Promise<GhError> => {
  try {
    await p;
  } catch (error) {
    return error as GhError;
  }
  throw new Error("expected a rejection");
};

describe("resolving gh", () => {
  it("finds the first executable gh on PATH", () => {
    const notExec = join(root, "noexec");
    mkdirSync(notExec);
    writeFileSync(join(notExec, "gh"), "#!/bin/sh\n", { mode: 0o644 });
    const gh = fakeGh(join(root, "later"));
    expect(resolveGh({ pathEnv: `${notExec}:${join(root, "later")}` })).toEqual({ path: gh });
  });

  it("says where it looked and how to fix it when gh is missing", () => {
    const error = (() => {
      try {
        resolveGh({ pathEnv: "/nonexistent-a:/nonexistent-b" });
      } catch (e) {
        return e as GhError;
      }
      throw new Error("expected a throw");
    })();
    expect(error).toBeInstanceOf(GhError);
    expect(error).toMatchObject({ problem: "not_found", code: "gh_not_found", status: 422 });
    expect(error.message).toContain("login shell");
    expect(error.message).toContain("ocd restart");
    expect(error.details).toEqual({ searched: ["/nonexistent-a", "/nonexistent-b"] });
  });
});

describe("classifying gh failures", () => {
  it("tells network, invalid login, missing login and other failures apart", () => {
    const cases: [string, string][] = [
      ["error connecting to api.github.com", "unreachable"],
      ["X Timeout trying to log in to github.com account me (keyring)", "unreachable"],
      ["dial tcp: lookup api.github.com: no such host", "unreachable"],
      ["HTTP 502: Bad Gateway", "unreachable"],
      ["The token in keyring is invalid.\nTo re-authenticate, run: gh auth login", "auth_invalid"],
      ["HTTP 401: Bad credentials", "auth_invalid"],
      ["You are not logged into any GitHub hosts. To log in, run: gh auth login", "auth_missing"],
      ["To get started with GitHub CLI, please run:  gh auth login", "auth_missing"],
      ["no pull requests found for branch", "failed"],
      ["GraphQL: Head sha can't be blank", "failed"],
    ];
    for (const [output, problem] of cases)
      expect([output, classifyGhOutput(output)]).toEqual([output, problem]);
  });
});

describe("running gh", () => {
  const at = (path: string): GhLocation => ({ path });

  it("passes arguments verbatim without a shell, feeds stdin and disables prompts", async () => {
    const gh = fakeGh();
    const hostile = `$(touch ${join(root, "pwned")}); "q" 'x' \`id\` | cat`;
    await runGh(at(gh), ["pr", "create", "--title", hostile, "--body-file", "-"], {
      cwd: root,
      input: "the body",
    });
    expect(calls(gh)).toEqual([["pr", "create", "--title", hostile, "--body-file", "-"]]);
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(readFileSync(join(root, "bin", "body.txt"), "utf8")).toBe("the body");
    expect(readFileSync(join(root, "bin", "env.log"), "utf8")).toContain("GH_PROMPT_DISABLED=1");
  });

  it("turns failures into actionable, redacted errors", async () => {
    const gh = fakeGh(undefined, "auth_missing");
    expect(await caught(runGh(at(gh), ["pr", "view", "x"], { cwd: root }))).toMatchObject({
      code: "gh_auth_required",
      problem: "auth_missing",
    });
    setMode(gh, "network");
    const offline = await caught(runGh(at(gh), ["pr", "view", "x"], { cwd: root }));
    expect(offline).toMatchObject({ code: "gh_unreachable", status: 503 });
    expect(offline.message).toContain("login was not the problem");
    setMode(gh, "leak");
    const leak = await caught(runGh(at(gh), ["pr", "view", "x"], { cwd: root }));
    expect(leak.problem).toBe("auth_invalid");
    expect(leak.message).not.toContain("ghp_abcdefghij");
    expect(leak.message).toContain("[REDACTED]");
  });

  it("gives up on a hung gh within the timeout", async () => {
    const gh = fakeGh(undefined, "hang");
    const started = Date.now();
    const error = await caught(runGh(at(gh), ["pr", "view", "x"], { cwd: root, timeoutMs: 300 }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(error).toMatchObject({ code: "gh_unreachable" });
  });

  it("reports a gh that disappeared after it was found", async () => {
    const gh = fakeGh();
    unlinkSync(gh);
    expect(await caught(runGh(at(gh), ["--version"], { cwd: root }))).toMatchObject({
      code: "gh_not_found",
    });
  });
});

describe("startup check (probeGh)", () => {
  it("reports version, path and a working login", async () => {
    const gh = fakeGh();
    const status = await probeGh({ pathEnv: join(gh, ".."), cwd: root, now: () => new Date(0) });
    expect(status).toEqual({
      available: true,
      path: gh,
      version: "9.9.9",
      auth: "ok",
      problem: null,
      problems: [],
      checkedAt: new Date(0).toISOString(),
    });
    // Read-only commands only.
    expect(calls(gh)).toEqual([["--version"], ["auth", "status"]]);
  });

  it("distinguishes a missing gh, a missing login, a rejected token and no network", async () => {
    expect(await probeGh({ pathEnv: "" })).toMatchObject({
      available: false,
      problem: "not_found",
      auth: "unknown",
    });
    const gh = fakeGh();
    const probe = () => probeGh({ pathEnv: join(gh, ".."), cwd: root });
    setMode(gh, "logged_out");
    expect(await probe()).toMatchObject({
      available: true,
      auth: "missing",
      problem: "auth_missing",
    });
    setMode(gh, "bad_token");
    expect(await probe()).toMatchObject({ auth: "invalid", problem: "auth_invalid" });
    // Offline is not "logged out": the login is left unverified.
    setMode(gh, "offline");
    const offline = await probe();
    expect(offline).toMatchObject({ available: true, auth: "unknown", problem: "unreachable" });
    expect(offline.problems.join(" ")).not.toContain("gh auth login");
  });

  it("is bounded when GitHub does not answer", async () => {
    const gh = fakeGh(undefined, "auth_hang");
    const started = Date.now();
    const status = await probeGh({ pathEnv: join(gh, ".."), cwd: root, timeoutMs: 2000 });
    // The fake hangs for 30s; the check gives up after the timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(status).toMatchObject({ available: true, auth: "unknown", problem: "unreachable" });
  });

  it("never exposes a token gh prints", async () => {
    const gh = fakeGh(undefined, "leak");
    const status = await probeGh({ pathEnv: join(gh, ".."), cwd: root });
    expect(JSON.stringify(status)).not.toContain("ghp_abcdefghij");
  });
});

describe("GhPullRequests (every gh call site)", () => {
  it("creates a PR with argument arrays after checking for an open one", async () => {
    const gh = fakeGh();
    const prs = new GhPullRequests({ pathEnv: join(gh, "..") });
    const input = {
      cwd: root,
      head: "ocd/t_1",
      base: "main",
      title: "Fix `gh` $(discovery)",
      body: "body",
      draft: true,
    };
    expect(await prs.create(input)).toEqual({ url: "https://github.com/o/r/pull/7" });
    expect(calls(gh)).toEqual([
      [
        "pr",
        "list",
        "--head",
        "ocd/t_1",
        "--base",
        "main",
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      [
        "pr",
        "create",
        "--head",
        "ocd/t_1",
        "--base",
        "main",
        "--title",
        "Fix `gh` $(discovery)",
        "--body-file",
        "-",
        "--draft",
      ],
    ]);
  });

  it("reuses an open PR for the branch instead of opening a second one", async () => {
    const gh = fakeGh();
    writeFileSync(join(root, "bin", "list.json"), '[{"url":"https://github.com/o/r/pull/3"}]');
    const prs = new GhPullRequests({ pathEnv: join(gh, "..") });
    expect(
      await prs.create({ cwd: root, head: "h", base: "main", title: "t", body: "b", draft: false }),
    ).toEqual({ url: "https://github.com/o/r/pull/3", existing: true });
    expect(calls(gh).map((c) => c.slice(0, 2).join(" "))).toEqual(["pr list"]);
  });

  it("reads status and merges without admin overrides", async () => {
    const gh = fakeGh();
    writeFileSync(
      join(root, "bin", "view.json"),
      JSON.stringify({
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
        headRefOid: "abc123def456",
      }),
    );
    const prs = new GhPullRequests({ pathEnv: join(gh, "..") });
    const status = await prs.status("https://github.com/o/r/pull/7", root);
    expect(status).toMatchObject({
      state: "open",
      mergeable: "mergeable",
      failingChecks: [],
      headSha: "abc123def456",
    });
    await prs.merge("https://github.com/o/r/pull/7", root, "squash", status.headSha);
    expect(calls(gh).at(-1)).toEqual([
      "pr",
      "merge",
      "https://github.com/o/r/pull/7",
      "--squash",
      "--match-head-commit",
      "abc123def456",
    ]);
  });

  it("looks gh up on every call, so a gh installed after startup is used", async () => {
    const saved = process.env["PATH"];
    process.env["PATH"] = `${join(root, "bin")}:/usr/bin:/bin`;
    try {
      const prs = new GhPullRequests();
      expect(await caught(prs.status("u", root))).toMatchObject({ code: "gh_not_found" });
      fakeGh();
      writeFileSync(join(root, "bin", "view.json"), '{"state":"MERGED","isDraft":false}');
      expect((await prs.status("u", root)).state).toBe("merged");
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("fails each action with the same actionable error when gh is missing or logged out", async () => {
    const missing = new GhPullRequests({ pathEnv: "/nonexistent" });
    {
      const input = { cwd: root, head: "h", base: "main", title: "t", body: "b", draft: false };
      for (const action of [
        () => missing.create(input),
        () => missing.status("u", root),
        () => missing.merge("u", root, "squash"),
      ])
        expect(await caught(action())).toMatchObject({ code: "gh_not_found" });
    }
    const gh = fakeGh(undefined, "auth_missing");
    const loggedOut = new GhPullRequests({ pathEnv: join(gh, "..") });
    expect(await caught(loggedOut.merge("u", root, "merge"))).toMatchObject({
      code: "gh_auth_required",
    });
  });
});

describe("pull request actions in the supervisor", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

  async function finishedTaskWithOrigin(harness: Harness, key: string) {
    const path = makeRepo(harness.root, "app");
    const origin = join(harness.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(path, "remote", "add", "origin", origin);
    git(path, "push", "-q", "-u", "origin", "main");
    git(path, "remote", "set-head", "origin", "main");
    await declareRepos(harness, { app: { path, profile: "fake" } });
    const { task } = await harness.human.dispatch({
      repo: "app",
      title: "Write the file",
      instructions: "x",
      idempotencyKey: key,
    });
    return (await waitForState(harness, task.id, "ready_for_review")).task;
  }

  it("records an interrupted PR attempt with an actionable error, then retries once", async () => {
    const prs = new RecordingPullRequests();
    prs.failure = new GhError(
      "not_found",
      "GitHub CLI (gh) was not found on the supervisor's PATH. Install gh, then run `ocd restart`",
    );
    h = await startHarness({ pullRequests: prs });
    const task = await finishedTaskWithOrigin(h, "gh-missing");

    await expect(h.manager("mgr").openPullRequest(task.id, { commit: true })).rejects.toMatchObject(
      {
        code: "gh_not_found",
        message: expect.stringContaining("ocd restart"),
      },
    );
    const detail = await h.human.inspectTask(task.id);
    expect(detail.task.pullRequestUrl).toBeNull();
    expect(detail.events.find((e) => e.type === "pull_request.failed")?.data).toMatchObject({
      stage: "create",
      pushed: true,
      code: "gh_not_found",
      branch: task.branch,
    });

    prs.failure = null;
    const opened = await h.human.openPullRequest(task.id);
    expect(opened.pullRequestUrl).toBe("https://example.test/pr/1");
    expect(prs.created).toHaveLength(1);
  });

  it("leaves pull requests off until github.enabled turns them on", async () => {
    const prs = new RecordingPullRequests();
    const factory = ({ config }: { config: { github: { enabled: boolean } } }) =>
      config.github.enabled ? prs : undefined;
    h = await startHarness({ pullRequests: factory });
    const off = await finishedTaskWithOrigin(h, "gh-disabled");
    await expect(h.human.openPullRequest(off.id, { commit: true })).rejects.toMatchObject({
      code: "pr_unavailable",
      message: expect.stringContaining('"github": { "enabled": true }'),
    });
    expect((await h.human.status()).github ?? null).toBeNull();
    expect((await h.human.status()).pullRequests).toBe(false);
    await h.cleanup();

    h = await startHarness({ pullRequests: factory, config: { github: { enabled: true } } });
    expect((await h.human.status()).pullRequests).toBe(true);
    const on = await finishedTaskWithOrigin(h, "gh-enabled");
    expect((await h.human.openPullRequest(on.id, { commit: true })).pullRequestUrl).toBe(
      "https://example.test/pr/1",
    );
  });

  it("adopts a PR that already exists for the branch instead of opening another", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    const task = await finishedTaskWithOrigin(h, "gh-existing");
    prs.openByHead.set(task.branch!, "https://example.test/pr/existing");
    const opened = await h.human.openPullRequest(task.id, { commit: true });
    expect(opened.pullRequestUrl).toBe("https://example.test/pr/existing");
    expect(prs.created).toEqual([]);
    const event = (await h.human.inspectTask(task.id)).events.find(
      (e) => e.type === "pull_request.opened",
    );
    expect(event?.data).toMatchObject({ existing: true });
  });

  it("keeps merge safety when GitHub is unreachable: nothing merged, failure recorded", async () => {
    const prs = new RecordingPullRequests();
    h = await startHarness({ pullRequests: prs });
    const task = await finishedTaskWithOrigin(h, "gh-offline");
    await h.human.openPullRequest(task.id, { commit: true });
    await h.human.acceptTask(task.id);
    prs.failure = new GhError(
      "unreachable",
      "gh pr view failed: error connecting to api.github.com",
    );
    await expect(h.manager("mgr").mergePullRequest(task.id)).rejects.toMatchObject({
      code: "gh_unreachable",
    });
    expect(prs.merged).toEqual([]);
    const detail = await h.human.inspectTask(task.id);
    expect(detail.task.workspacePath).not.toBeNull();
    expect(detail.events.find((e) => e.type === "pull_request.failed")?.data).toMatchObject({
      stage: "status",
      code: "gh_unreachable",
    });
  });

  it("starts without waiting for the gh check and shows its result in status", async () => {
    const prs = new RecordingPullRequests();
    let finish!: () => void;
    prs.probeResult = () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            available: true,
            path: "/x/gh",
            version: "1",
            auth: "missing",
            problem: "auth_missing",
            problems: ["Run `gh auth login`"],
            checkedAt: new Date(0).toISOString(),
          });
      });
    h = await startHarness({ pullRequests: prs });
    expect((await h.human.status()).github).toBeNull();
    finish();
    await expect.poll(async () => (await h!.human.status()).github?.auth).toBe("missing");
  });

  it("a failing gh check is non-fatal", async () => {
    const prs = new RecordingPullRequests();
    prs.probeResult = () => Promise.reject(new Error("boom"));
    h = await startHarness({ pullRequests: prs });
    expect((await h.human.status()).github).toBeNull();
  });

  it("runs the gh found on PATH for real pull request calls end to end", async () => {
    const gh = fakeGh();
    h = await startHarness({ pullRequests: () => new GhPullRequests({ pathEnv: join(gh, "..") }) });
    // The startup check runs this freshly written script twice in the
    // background; on a loaded machine a single exec of it can take seconds.
    await expect
      .poll(async () => (await h!.human.status()).github, { timeout: 10_000 })
      .toMatchObject({ path: gh, auth: "ok" });
    const task = await finishedTaskWithOrigin(h, "gh-end-to-end");
    const opened = await h.human.openPullRequest(task.id, { commit: true });
    expect(opened.pullRequestUrl).toBe("https://github.com/o/r/pull/7");
    const prCalls = calls(gh).filter((c) => c[0] === "pr");
    expect(prCalls.map((c) => c.slice(0, 2).join(" "))).toEqual(["pr list", "pr create"]);
    expect(prCalls[1]).toContain(task.branch);
  });
});
