import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FakeAdapter,
  FakeHarnessState,
  type FakeAdapterOptions,
  type HarnessAdapter,
} from "@ocd/adapters";
import { OcdClient, type OcdPaths, type Actor, type RepoConfig } from "@ocd/core";

import type { SupervisorConfigInput } from "./config.ts";
import { startDaemon, type Daemon, type DaemonOptions } from "./daemon.ts";
import { systemGit, type ExecResult, type GitRunner } from "./git.ts";
import { createLogger } from "./logger.ts";
import { RecordingManagerChannel, RecordingNotifier } from "./notify.ts";

// Fixtures for routine tests: temporary state directories and git repositories,
// fake harnesses, and recording notifiers. Nothing here calls a real model.

export function tempDir(prefix = "ocd-test-"): string {
  // Short base path keeps Unix socket paths under the 104-byte limit.
  return realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), prefix)));
}

export function testPaths(home: string): OcdPaths {
  const runDir = join(home, "run");
  return {
    home,
    db: join(home, "ocd.db"),
    config: join(home, "ocd.jsonc"),
    runDir,
    socket: join(runDir, "s.sock"),
    lock: join(runDir, "supervisor.lock"),
    logs: join(home, "logs"),
    workspaces: join(home, "workspaces"),
    backups: join(home, "backups"),
    token: join(runDir, "api.token"),
  };
}

/**
 * Repository config for test repos, written as a file rather than with
 * `git config` calls. Auto-maintenance is off: otherwise every commit, fetch
 * and received push spawns `git maintenance run --auto`, which costs hundreds
 * of milliseconds per call on a loaded machine.
 */
const TEST_GIT_CONFIG = `[user]
\temail = test@example.com
\tname = OCD Test
[commit]
\tgpgsign = false
[maintenance]
\tauto = false
`;

export function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  appendFileSync(join(path, ".git", "config"), TEST_GIT_CONFIG);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return realpathSync(path);
}

export interface Harness {
  root: string;
  paths: OcdPaths;
  fakeState: FakeHarnessState;
  notifier: RecordingNotifier;
  managerChannel: RecordingManagerChannel;
  daemon: Daemon;
  adapter: FakeAdapter;
  human: OcdClient;
  /** `manager.directory` configured for this harness. */
  managerDirectory: string;
  /** A plugin-style client for an OpenCode session in `directory` (default: the manager directory). */
  manager(sessionId: string, directory?: string): OcdClient;
  restart(overrides?: Partial<HarnessOptions>): Promise<Daemon>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  config: Partial<SupervisorConfigInput>;
  pullRequests: NonNullable<DaemonOptions["pullRequests"]>;
  /** Replace the default fake adapter (e.g. with an OpenCode adapter over a fake service). */
  adapters: (fake: FakeAdapter) => HarnessAdapter[];
  fake: Omit<FakeAdapterOptions, "state">;
  hooks: DaemonOptions["hooks"];
  clock: DaemonOptions["clock"];
}

export const TEST_CONFIG: Partial<SupervisorConfigInput> = {
  allowFakeHarness: true,
  profiles: { fake: { harness: "fake", model: "fake/model", permissionPolicy: "ask" } },
  schedulerIntervalMs: 20,
  backups: { intervalHours: 0 },
  reconcileIntervalMs: 60_000,
  outbox: { intervalMs: 20, maxAttempts: 3, baseDelayMs: 10 },
  // Digests have their own tests (outbox.test.ts); elsewhere, deliver on the next pass.
  notifications: { digestWindowMs: 0 },
};

export async function startHarness(options: Partial<HarnessOptions> = {}): Promise<Harness> {
  const root = tempDir();
  const paths = testPaths(join(root, "home"));
  const fakeState = new FakeHarnessState();
  const notifier = new RecordingNotifier();
  const managerChannel = new RecordingManagerChannel();
  let adapter!: FakeAdapter;

  const managerDirectory = join(root, "manager");
  mkdirSync(managerDirectory);
  const boot = async (opts: Partial<HarnessOptions>) => {
    const daemon = await startDaemon({
      paths,
      config: {
        manager: { directory: managerDirectory },
        ...TEST_CONFIG,
        ...opts.config,
        profiles: { ...TEST_CONFIG.profiles, ...opts.config?.profiles },
      },
      adapters: () => {
        adapter = new FakeAdapter({ ...opts.fake, state: fakeState });
        return opts.adapters ? opts.adapters(adapter) : [adapter];
      },
      managerChannel: () => managerChannel,
      notifier,
      ...(opts.pullRequests ? { pullRequests: opts.pullRequests } : {}),
      logger: createLogger({ level: process.env["OCD_TEST_LOG"] ?? "silent" }),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    return daemon;
  };

  const client = (actor: Actor, sessionId?: string, directory?: string) =>
    new OcdClient({
      socketPath: paths.socket,
      actor,
      ...(sessionId ? { sessionId } : {}),
      ...(directory ? { directory } : {}),
    });

  const harness: Harness = {
    root,
    paths,
    fakeState,
    notifier,
    managerChannel,
    daemon: await boot(options),
    get adapter() {
      return adapter;
    },
    human: client("human"),
    managerDirectory,
    manager: (sessionId, directory = managerDirectory) => client("manager", sessionId, directory),
    async restart(overrides = {}) {
      harness.daemon = await boot({ ...options, ...overrides });
      return harness.daemon;
    },
    async cleanup() {
      await harness.daemon.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * Creates a git repo and declares it under `repos` in the harness's ocd.jsonc,
 * then reloads. Rejects with the config error if the declaration is invalid.
 */
export async function setupRepo(h: Harness, name = "app", profile = "fake"): Promise<string> {
  const path = makeRepo(h.root, name);
  await declareRepos(h, { [name]: { path, profile } });
  return path;
}

export async function declareRepos(h: Harness, repos: Record<string, RepoConfig>): Promise<void> {
  const current: { repos?: Record<string, unknown> } = existsSync(h.paths.config)
    ? JSON.parse(readFileSync(h.paths.config, "utf8"))
    : {};
  writeFileSync(
    h.paths.config,
    JSON.stringify({ ...current, repos: { ...current.repos, ...repos } }, null, 2),
  );
  await h.daemon.reload();
  const declared = new Set((await h.human.listRepos()).map((r) => r.name));
  const missing = Object.keys(repos).filter((name) => !declared.has(name));
  if (missing.length > 0) {
    const errors = (await h.human.listAttention({ status: "open" })).filter((a) =>
      a.reason.startsWith("ocd.jsonc is invalid"),
    );
    throw new Error(errors[0]?.reason ?? `Repos not declared: ${missing.join(", ")}`);
  }
}

export async function waitFor<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  let last: T = await fn();
  while (!predicate(last)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `waitFor timed out; last value: ${JSON.stringify(last, null, 2)?.slice(0, 2000)}`,
      );
    }
    await delay(15);
    last = await fn();
  }
  return last;
}

export async function waitForState(
  h: Harness,
  taskId: string,
  state: string | string[],
  timeoutMs = 5000,
) {
  const states = Array.isArray(state) ? state : [state];
  return waitFor(
    () => h.human.inspectTask(taskId),
    (d) => states.includes(d.task.state),
    timeoutMs,
  );
}

export function rmrf(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * The real git, except that a command matching `when` gets `result` instead of
 * running: a way to fail or hang one step of an otherwise real repository.
 */
export function failingGit(
  when: (args: string[]) => boolean,
  result: Partial<ExecResult> = { code: 1, stderr: "simulated failure" },
): GitRunner {
  return {
    run: async (args, options) =>
      when(args)
        ? { code: 1, stdout: "", stderr: "", timedOut: false, ...result }
        : systemGit.run(args, options),
    capped: (args, options) => systemGit.capped(args, options),
  };
}
