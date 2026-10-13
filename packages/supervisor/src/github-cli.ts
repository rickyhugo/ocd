import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { redact, truncate, type GitHubCliProblem, type GitHubCliStatus } from "@ocd/core";

import { ApiError } from "./errors.ts";

// The one place OCD finds and runs the GitHub CLI. Every pull request action
// goes through runGh: an explicit `gh.binary` from ocd.jsonc, else a PATH
// lookup, argument arrays only (no shell), no prompts, and failures sorted into
// problems a person can act on. gh's output is redacted before it is shown.

export type GhProblem = GitHubCliProblem;

const CODES: Record<GhProblem, { status: number; code: string }> = {
  not_found: { status: 422, code: "gh_not_found" },
  invalid_path: { status: 422, code: "gh_invalid_path" },
  auth_missing: { status: 422, code: "gh_auth_required" },
  auth_invalid: { status: 422, code: "gh_auth_required" },
  unreachable: { status: 503, code: "gh_unreachable" },
  failed: { status: 502, code: "gh_failed" },
};

/** A gh failure, surfaced through the API with a stable code and recovery advice. */
export class GhError extends ApiError {
  readonly problem: GhProblem;

  constructor(problem: GhProblem, message: string, details?: unknown) {
    super(CODES[problem].status, CODES[problem].code, message, details);
    this.problem = problem;
    this.name = "GhError";
  }
}

const CONFIG_HINT =
  'set "gh": { "binary": "/absolute/path/to/gh" } in ocd.jsonc (find it with `command -v gh` or `mise which gh` in your shell; saved changes apply without a restart)';

export const GH_HINTS: Record<GhProblem, string> = {
  not_found: `The supervisor inherits the PATH of whatever started it; a LaunchAgent or systemd unit does not read your shell profile or mise activation, so gh can work in your terminal and still be missing here. Either ${CONFIG_HINT}, or install gh into a directory on the supervisor's PATH. \`ocd doctor\` compares both.`,
  invalid_path:
    "Fix gh.binary in ocd.jsonc so it names the gh executable, or remove it to look gh up on PATH.",
  auth_missing:
    "Run `gh auth login` in a terminal as the same user (OCD never starts a login itself), then retry.",
  auth_invalid:
    "GitHub rejected gh's stored token. Run `gh auth refresh` or `gh auth login` in a terminal, then retry.",
  unreachable:
    "GitHub could not be reached (network, VPN, proxy or a GitHub outage); gh's login was not the problem. Retry when the connection is back.",
  failed: "",
};

/** Expands `~/`; everything else is used as written. */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface GhLocation {
  path: string;
  source: "config" | "path";
}

export interface ResolveGhOptions {
  /** `gh.binary` from ocd.jsonc. When set it is used or reported, never silently skipped. */
  configured?: string | null | undefined;
  /** PATH to search; defaults to this process's. */
  pathEnv?: string | undefined;
  /** Searched after PATH (the platform's usual user bin directories). */
  extraDirs?: readonly string[];
}

/** Finds gh: the configured executable, else the first executable `gh` on PATH. Throws GhError. */
export function resolveGh(options: ResolveGhOptions = {}): GhLocation {
  if (options.configured) {
    const path = expandHome(options.configured);
    if (!isAbsolute(path))
      throw new GhError(
        "invalid_path",
        `gh.binary must be an absolute path (got ${options.configured}). ${GH_HINTS.invalid_path}`,
      );
    let kind: string | null = null;
    try {
      const s = statSync(path);
      if (!s.isFile()) kind = "is not a file";
      else {
        try {
          accessSync(path, constants.X_OK);
        } catch {
          kind = "is not executable";
        }
      }
    } catch {
      kind = "does not exist";
    }
    if (kind)
      throw new GhError(
        "invalid_path",
        `gh.binary in ocd.jsonc (${path}) ${kind}. ${GH_HINTS.invalid_path}`,
        { configured: path },
      );
    return { path, source: "config" };
  }
  const pathEnv = options.pathEnv ?? process.env["PATH"] ?? "";
  const dirs = [...new Set([...pathEnv.split(delimiter), ...(options.extraDirs ?? [])])].filter(
    Boolean,
  );
  for (const dir of dirs) {
    const candidate = join(dir, "gh");
    if (isExecutableFile(candidate)) return { path: candidate, source: "path" };
  }
  throw new GhError(
    "not_found",
    `GitHub CLI (gh) was not found on the supervisor's PATH. ${GH_HINTS.not_found}`,
    { searched: dirs },
  );
}

// gh's wording varies across versions and commands; network failures are
// checked first because `gh auth status` reports them as a failed login too.
const NETWORK =
  /error connecting to|could not resolve host|no such host|dial tcp|connection refused|connection reset|network is unreachable|i\/o timeout|tls handshake|timeout trying to|check your internet connection|context deadline exceeded|HTTP 50[0-4]|unexpected EOF|proxyconnect/i;
const AUTH_INVALID =
  /token[^\n]* is (?:invalid|expired)|bad credentials|HTTP 401|requires? (?:re-?)?authentication|gh auth refresh/i;
const AUTH_MISSING =
  /not logged in|gh auth login|authentication required|no oauth token|GH_TOKEN environment variable/i;

/** Sorts gh's error output into a problem kind. */
export function classifyGhOutput(output: string): GhProblem {
  if (NETWORK.test(output)) return "unreachable";
  if (AUTH_INVALID.test(output)) return "auth_invalid";
  if (AUTH_MISSING.test(output)) return "auth_missing";
  return "failed";
}

/**
 * The environment gh runs with: the supervisor's own (gh needs HOME, its
 * config dir, GH_TOKEN/GH_HOST and proxy settings), never interactive.
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
  };
}

export interface RunGhOptions {
  cwd: string;
  /** Written to gh's stdin (e.g. a PR body for --body-file -); stdin is closed either way. */
  input?: string;
  timeoutMs?: number;
  /** False for local-only commands (--version): a timeout is then not a network problem. */
  network?: boolean;
}

/** gh's output with secrets removed and long text cut, safe for errors, events and logs. */
export function safeGhText(text: string, max = 1500): string {
  return truncate(redact(text.trim()), max);
}

/**
 * Runs gh with an argument array (never a shell). Resolves to stdout; rejects
 * with a GhError naming the subcommand, gh's (redacted) message and a fix.
 */
export function runGh(
  location: GhLocation,
  args: string[],
  options: RunGhOptions,
): Promise<string> {
  const label = `gh ${args.slice(0, 2).join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      location.path,
      args,
      {
        cwd: options.cwd,
        env: ghEnv(),
        timeout: options.timeoutMs ?? 120_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout));
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === "ENOENT" || errno === "EACCES") {
          const problem = location.source === "config" ? "invalid_path" : "not_found";
          return reject(
            new GhError(
              problem,
              `${label} failed: ${location.path} could not be started (${errno}). ${GH_HINTS[problem]}`,
            ),
          );
        }
        if (error.killed) {
          const seconds = Math.round((options.timeoutMs ?? 120_000) / 1000);
          return reject(
            options.network === false
              ? new GhError("failed", `${label} did not finish within ${seconds}s`)
              : new GhError(
                  "unreachable",
                  `${label} did not finish within ${seconds}s. ${GH_HINTS.unreachable}`,
                ),
          );
        }
        const output = safeGhText(String(stderr) || String(stdout) || error.message);
        const problem = classifyGhOutput(output);
        const hint = GH_HINTS[problem];
        reject(new GhError(problem, `${label} failed: ${output}${hint ? `\n${hint}` : ""}`));
      },
    );
    // A closed stdin means gh can never wait on a prompt.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

export interface ProbeGhOptions extends ResolveGhOptions {
  cwd?: string;
  /** Per command; the probe makes at most two calls. */
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Read-only startup check: can gh be found and run, and is it logged in?
 * Bounded by timeouts, never prompts, never throws. A network failure or a
 * timeout leaves auth "unknown" rather than claiming the login is missing.
 */
export async function probeGh(options: ProbeGhOptions = {}): Promise<GitHubCliStatus> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const base = {
    path: null,
    source: null,
    version: null,
    auth: "unknown",
    checkedAt,
  } satisfies Partial<GitHubCliStatus>;
  let location: GhLocation;
  try {
    location = resolveGh(options);
  } catch (error) {
    const e = error as GhError;
    return { ...base, available: false, problem: e.problem ?? "failed", problems: [e.message] };
  }
  const run = { cwd: options.cwd ?? homedir(), timeoutMs: options.timeoutMs ?? 10_000 };
  let version: string;
  try {
    const out = await runGh(location, ["--version"], { ...run, network: false });
    version = /gh version (\S+)/.exec(out)?.[1] ?? safeGhText(out.split("\n")[0] ?? "", 80);
  } catch (error) {
    const e = error as GhError;
    return {
      ...base,
      path: location.path,
      source: location.source,
      available: false,
      problem: e.problem,
      problems: [`${location.path} could not be run: ${e.message}`],
    };
  }
  const found = { ...base, path: location.path, source: location.source, version, available: true };
  try {
    // Exit 0 means every configured host has a working login.
    await runGh(location, ["auth", "status"], run);
    return { ...found, auth: "ok", problem: null, problems: [] };
  } catch (error) {
    const e = error as GhError;
    const auth =
      e.problem === "auth_missing"
        ? "missing"
        : e.problem === "auth_invalid"
          ? "invalid"
          : "unknown";
    return { ...found, auth, problem: e.problem, problems: [e.message] };
  }
}
