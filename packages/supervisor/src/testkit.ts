import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FakeAdapter,
  FakeHarnessState,
  type FakeAdapterOptions,
  type HarnessAdapter,
} from "@ocd/adapters";
import { OcdClient, type OcdPaths, type Actor } from "@ocd/core";

import type { SupervisorConfig } from "./config.ts";
import { startDaemon, type Daemon, type DaemonOptions } from "./daemon.ts";
import { createLogger } from "./logger.ts";
import { RecordingManagerChannel, RecordingNotifier } from "./notify.ts";

// Fixtures for routine tests: temporary state directories and git repositories,
// fake harnesses, and recording notifiers. Nothing here calls a real model.

export function tempDir(prefix = "ocd-test-"): string {
  // Short base path keeps Unix socket paths under the 104-byte limit.
  return realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), prefix)));
}

export function testPaths(home: string): OcdPaths {
  const runDir = join(home, "run");
  return {
    home,
    db: join(home, "ocd.db"),
    config: join(home, "config.json"),
    runDir,
    socket: join(runDir, "s.sock"),
    lock: join(runDir, "supervisor.lock"),
    logs: join(home, "logs"),
    workspaces: join(home, "workspaces"),
    backups: join(home, "backups"),
  };
}

export function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "OCD Test");
  git("config", "commit.gpgsign", "false");
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
  manager(sessionId: string): OcdClient;
  restart(overrides?: Partial<HarnessOptions>): Promise<Daemon>;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  config: Partial<SupervisorConfig>;
  /** Replace the default fake adapter (e.g. with an OpenCode adapter over a fake service). */
  adapters: (fake: FakeAdapter) => HarnessAdapter[];
  fake: Omit<FakeAdapterOptions, "state">;
  hooks: DaemonOptions["hooks"];
  clock: DaemonOptions["clock"];
}

export const TEST_CONFIG: Partial<SupervisorConfig> = {
  allowFakeHarness: true,
  schedulerIntervalMs: 20,
  reconcileIntervalMs: 60_000,
  outbox: { intervalMs: 20, maxAttempts: 3, baseDelayMs: 10 },
};

export async function startHarness(options: Partial<HarnessOptions> = {}): Promise<Harness> {
  const root = tempDir();
  const paths = testPaths(join(root, "home"));
  const fakeState = new FakeHarnessState();
  const notifier = new RecordingNotifier();
  const managerChannel = new RecordingManagerChannel();
  let adapter!: FakeAdapter;

  const boot = async (opts: Partial<HarnessOptions>) => {
    const daemon = await startDaemon({
      paths,
      config: { ...TEST_CONFIG, ...opts.config },
      adapters: () => {
        adapter = new FakeAdapter({ ...opts.fake, state: fakeState });
        return opts.adapters ? opts.adapters(adapter) : [adapter];
      },
      managerChannel: () => managerChannel,
      notifier,
      logger: createLogger({ level: process.env["OCD_TEST_LOG"] ?? "silent" }),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    return daemon;
  };

  const client = (actor: Actor, sessionId?: string) =>
    new OcdClient({ socketPath: paths.socket, actor, ...(sessionId ? { sessionId } : {}) });

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
    manager: (sessionId) => client("manager", sessionId),
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

export async function setupRepo(h: Harness, name = "app", profile = "fake"): Promise<string> {
  const path = makeRepo(h.root, name);
  const profiles = await h.human.listProfiles();
  if (!profiles.some((p) => p.name === profile)) {
    await h.human.addProfile({
      name: profile,
      harness: "fake",
      model: "fake/model",
      permissionPolicy: "ask",
    });
  }
  await h.human.addRepo({ name, path, defaultProfile: profile });
  return path;
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
