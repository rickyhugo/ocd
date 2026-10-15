import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { configurableHarnesses } from "@ocd/adapters";
import { redact, truncate, type UpdateStatus } from "@ocd/core";

import { normalizeDirectory } from "./config.ts";
import { conflict, forbidden } from "./errors.ts";
import { iso } from "./ids.ts";
import type { Logger } from "./logger.ts";
import { type GitRunner, gitText, systemGit } from "./git.ts";

// OCD updating itself. New commits on its own repository's branch are built
// into ~/.ocd/install/builds/<sha> (a detached worktree of that repository, so
// the user's checkout is never touched), booted once in a throwaway sandbox,
// and switched to by repointing ~/.ocd/install/current and restarting the
// background service, which runs the CLI through that link. The switch waits
// while workers run that a restart would interrupt.

export interface SelfUpdateSettings {
  enabled: boolean;
  repo: string;
  /** A checkout to follow instead of the declared `repo`. */
  path?: string | undefined;
  branch?: string | undefined;
  intervalMinutes: number;
  build: string[];
}

interface InstallState {
  current: string | null;
  previous: string | null;
  pending: { sha: string; subjects: string[]; builtAt: string } | null;
  lastError: { sha: string; message: string; at: string } | null;
  /** Set when a version was switched to; the next supervisor reports it once. */
  applied: { sha: string; from: string | null; at: string; notified: boolean } | null;
  checkedAt: string | null;
}

const EMPTY: InstallState = {
  current: null,
  previous: null,
  pending: null,
  lastError: null,
  applied: null,
  checkedAt: null,
};

export interface AfterUpdateStep {
  run: () => Promise<void>;
  /** The notification when it still fails after one retry: what to do by hand. */
  failed: { headline: string; detail: string };
}

export interface SelfUpdaterOptions {
  /** ~/.ocd/install */
  installDir: string;
  settings: () => SelfUpdateSettings;
  /** Path of a declared repository, or null. */
  repoPath: (name: string) => string | null;
  /** Live workers that a restart would interrupt. */
  blockers: () => { taskId: string; title: string; harness: string }[];
  notify: (key: string, title: string, body: string) => void;
  /** Stops gracefully and exits so the service manager starts the new version; null outside a service. */
  restart: (() => void) | null;
  /** Real path of the CLI the running supervisor was started from. */
  runningFrom: string;
  logger: Logger;
  /** Defaults to the real git; tests substitute a fake. */
  git?: GitRunner;
  clock?: () => number;
  /** Boots a build in a throwaway sandbox and throws if it does not come up. */
  smokeTest?: (buildDir: string) => Promise<void>;
  /** After a switch, in the new supervisor (e.g. reloading the manager host's plugins). */
  afterApplied?: AfterUpdateStep;
  /** Wait before the one retry of `afterApplied` (it can fail transiently). Default 30 s. */
  afterAppliedRetryMs?: number;
}

const short = (sha: string) => sha.slice(0, 7);
const dirName = (sha: string) => sha.slice(0, 12);

export class SelfUpdater {
  private readonly o: SelfUpdaterOptions;
  private readonly git: GitRunner;
  private state: InstallState;
  private building: string | null = null;
  private checking: Promise<UpdateStatus> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  /** The build directory the running supervisor was started from; never pruned. */
  private readonly runningBuild: string | null;

  constructor(options: SelfUpdaterOptions) {
    this.o = options;
    this.git = options.git ?? systemGit;
    this.state = this.load();
    const builds = join(options.installDir, "builds") + sep;
    this.runningBuild = options.runningFrom.startsWith(builds)
      ? (options.runningFrom.slice(builds.length).split(sep)[0] ?? null)
      : null;
  }

  private get now(): number {
    return (this.o.clock ?? Date.now)();
  }

  private get statePath(): string {
    return join(this.o.installDir, "state.json");
  }

  private get buildsDir(): string {
    return join(this.o.installDir, "builds");
  }

  /** ~/.ocd/install/current: the link the service and the plugin run through. */
  get currentLink(): string {
    return join(this.o.installDir, "current");
  }

  private load(): InstallState {
    try {
      return { ...EMPTY, ...JSON.parse(readFileSync(this.statePath, "utf8")) };
    } catch {
      return { ...EMPTY };
    }
  }

  private save(): void {
    mkdirSync(this.o.installDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  /** The running supervisor comes from ~/.ocd/install, so a switch takes effect on restart. */
  private get runningFromInstall(): boolean {
    try {
      const builds = realpathSync(this.buildsDir);
      return realpathSync(this.o.runningFrom).startsWith(builds + sep);
    } catch {
      return false;
    }
  }

  private cannotApply(): string | null {
    if (!this.o.restart)
      return "the supervisor is not running as a background service; restart it to use a new version";
    if (!this.runningFromInstall)
      return `the service runs ${this.o.runningFrom}, not ${this.currentLink}; run \`${join(this.currentLink, "packages/cli/dist/ocd.mjs")} service install\` once to run from it`;
    return null;
  }

  status(): UpdateStatus {
    const settings = this.o.settings();
    return {
      enabled: settings.enabled,
      current: this.state.current,
      previous: this.state.previous,
      pending: this.state.pending,
      blockedBy: this.state.pending && !this.cannotApply() ? this.o.blockers() : [],
      building: this.building,
      lastError: this.state.lastError,
      cannotApply: this.state.pending ? this.cannotApply() : null,
      checkedAt: this.state.checkedAt,
    };
  }

  /** Reports a switch made by the previous supervisor, then checks periodically. */
  start(): void {
    const applied = this.state.applied;
    if (applied && !applied.notified) {
      applied.notified = true;
      this.save();
      if (applied.sha === this.state.current) {
        this.o.notify(
          `update-applied:${applied.sha}`,
          "OCD: Updated",
          `Now running ${short(applied.sha)}${applied.from ? ` (was ${short(applied.from)})` : ""}.`,
        );
        void this.runAfterApplied(applied.sha);
      }
    }
    if (!this.o.settings().enabled) return;
    // A switch restarts right away, usually before its own prune finishes.
    void this.prune().catch((error: unknown) =>
      this.o.logger.warn({ err: error }, "pruning old OCD builds failed"),
    );
    const every = this.o.settings().intervalMinutes * 60_000;
    const first = setTimeout(() => void this.check().catch(() => undefined), 30_000);
    const poll = setInterval(() => void this.check().catch(() => undefined), every);
    // A pending version is switched to as soon as the workers it waits for are done.
    const apply = setInterval(() => void this.tryApply(false).catch(() => undefined), 20_000);
    for (const t of [first, poll, apply]) t.unref();
    this.timers.push(first, poll, apply);
  }

  /** Retries once; if the step still fails, says what to do by hand (once per build, via the key). */
  private async runAfterApplied(sha: string): Promise<void> {
    const step = this.o.afterApplied;
    if (!step) return;
    try {
      await step.run();
      return;
    } catch (error) {
      this.o.logger.warn({ err: error }, "after-update step failed; retrying");
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.o.afterAppliedRetryMs ?? 30_000);
      t.unref();
      this.timers.push(t);
    });
    if (this.stopped) return;
    try {
      await step.run();
    } catch (error) {
      this.o.logger.warn({ err: error }, "after-update step failed");
      this.o.notify(
        `update-after-failed:${sha}`,
        step.failed.headline,
        `OCD ${short(sha)} is running. ${step.failed.detail}`,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearTimeout(t);
  }

  /** OCD's own checkout: `selfUpdate.path`, else the declared `selfUpdate.repo`. */
  private sourcePath(): string | null {
    const settings = this.o.settings();
    return settings.path ? normalizeDirectory(settings.path) : this.o.repoPath(settings.repo);
  }

  /** A task landed in this repository: look for the new version soon. */
  landed(repo: string): void {
    const settings = this.o.settings();
    if (!settings.enabled || this.stopped) return;
    const landedIn = this.o.repoPath(repo);
    const ours = settings.path
      ? landedIn !== null && normalizeDirectory(landedIn) === this.sourcePath()
      : repo === settings.repo;
    if (!ours) return;
    const t = setTimeout(() => void this.check().catch(() => undefined), 5_000);
    t.unref();
    this.timers.push(t);
  }

  /** Fetches the branch and builds a new version if there is one. One at a time. */
  check(): Promise<UpdateStatus> {
    this.checking ??= this.checkOnce().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkOnce(): Promise<UpdateStatus> {
    const settings = this.o.settings();
    if (!settings.enabled)
      throw conflict("update_disabled", "selfUpdate.enabled is off in ocd.jsonc");
    const repoPath = this.sourcePath();
    if (!repoPath || (settings.path && !existsSync(repoPath)))
      throw conflict(
        "update_no_repo",
        settings.path
          ? `selfUpdate.path ${settings.path} does not exist`
          : `selfUpdate.repo "${settings.repo}" is not a declared repository`,
      );
    const branch = settings.branch ?? (await this.defaultBranch(repoPath));
    const fetched = await this.git.run(["fetch", "--quiet", "origin", branch], {
      cwd: repoPath,
      env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000,
    });
    if (fetched.code !== 0)
      this.o.logger.warn({ stderr: fetched.stderr.slice(-300) }, "self-update fetch failed");
    const target = await this.text(repoPath, [
      "rev-parse",
      "--verify",
      `origin/${branch}^{commit}`,
    ]);
    this.state.checkedAt = iso(this.now);
    this.save();
    const known =
      target === this.state.current ||
      target === this.state.pending?.sha ||
      target === this.state.lastError?.sha;
    if (!known && !this.stopped) await this.build(repoPath, target);
    await this.tryApply(false);
    return this.status();
  }

  private text(cwd: string, args: string[]): Promise<string> {
    return gitText(this.git, cwd, args);
  }

  private async defaultBranch(repoPath: string): Promise<string> {
    const r = await this.git.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
    });
    const ref = r.stdout.trim();
    return r.code === 0 && ref.startsWith("origin/") ? ref.slice("origin/".length) : "main";
  }

  private async build(repoPath: string, sha: string): Promise<void> {
    const settings = this.o.settings();
    const dir = join(this.buildsDir, dirName(sha));
    const logFile = `${dir}.log`;
    this.building = sha;
    this.o.logger.info({ sha }, "building a new OCD version");
    let output = "";
    try {
      mkdirSync(this.buildsDir, { recursive: true });
      await this.removeBuild(repoPath, dir);
      await this.text(repoPath, ["worktree", "add", "--detach", "--force", dir, sha]);
      for (const command of settings.build) {
        const r = await shell(command, dir, 20 * 60_000);
        output += `$ ${command}\n${r.output}\n`;
        if (r.code !== 0)
          throw new Error(`\`${command}\` failed (${r.code ?? "timeout"}): ${tail(r.output)}`);
      }
      await (this.o.smokeTest ?? bootSmokeTest)(dir);
      const subjects = (
        await this.text(repoPath, [
          "log",
          "--format=%s",
          "-n",
          "20",
          this.state.current ? `${this.state.current}..${sha}` : sha,
        ]).catch(() => "")
      )
        .split("\n")
        .filter(Boolean);
      this.state.pending = { sha, subjects, builtAt: iso(this.now) };
      this.state.lastError = null;
      this.save();
      this.o.logger.info({ sha }, "new OCD version built and smoke-tested");
    } catch (error) {
      const message = truncate(redact(error instanceof Error ? error.message : String(error)), 600);
      this.state.lastError = { sha, message, at: iso(this.now) };
      this.save();
      this.o.logger.warn({ sha, err: error }, "OCD update failed to build");
      this.o.notify(
        `update-failed:${sha}`,
        "OCD: Update failed",
        `${short(sha)} did not build; still running ${this.state.current ? short(this.state.current) : "the current version"}. ${message.slice(0, 120)}`,
      );
      await this.removeBuild(repoPath, dir).catch(() => undefined);
    } finally {
      try {
        writeFileSync(logFile, output);
      } catch {
        // the log is a convenience
      }
      this.building = null;
    }
  }

  /**
   * Switches to the pending version: now, if nothing would be interrupted (or
   * `force`), else once the blocking workers are done.
   */
  async tryApply(force: boolean): Promise<UpdateStatus> {
    const pending = this.state.pending;
    if (!pending || this.stopped) return this.status();
    const blockers = this.cannotApply() ? [] : this.o.blockers();
    if (blockers.length && !force) {
      this.o.notify(
        `update-waiting:${pending.sha}`,
        "OCD: Update ready",
        `${short(pending.sha)} waits for ${blockers.length} worker${blockers.length === 1 ? "" : "s"} to finish. Apply now from the sidebar or with \`ocd update apply\`.`,
      );
      return this.status();
    }
    this.switchTo(pending.sha);
    this.state.pending = null;
    const reason = this.cannotApply();
    if (reason) {
      // Installed, but this supervisor does not run from the install: say how.
      this.state.applied = {
        sha: pending.sha,
        from: this.state.previous,
        at: iso(this.now),
        notified: true,
      };
      this.save();
      this.o.notify(
        `update-installed:${pending.sha}`,
        "OCD: Update installed",
        `${short(pending.sha)}: ${reason}.`,
      );
      return this.status();
    }
    this.state.applied = {
      sha: pending.sha,
      from: this.state.previous,
      at: iso(this.now),
      notified: false,
    };
    this.save();
    this.o.logger.info({ sha: pending.sha }, "switching to a new OCD version; restarting");
    this.o.restart!();
    return this.status();
  }

  /** Back to the previous version, unless it predates the database's migrations. */
  async rollback(): Promise<UpdateStatus> {
    const { current, previous } = this.state;
    if (!previous || !existsSync(join(this.buildsDir, dirName(previous))))
      throw conflict("update_no_previous", "There is no previous version to go back to");
    if (!this.o.restart || !this.runningFromInstall)
      throw forbidden("update_not_installed", this.cannotApply() ?? "not running from the install");
    if (current && migrations(this.buildDir(current)) > migrations(this.buildDir(previous)))
      throw conflict(
        "rollback_unsafe",
        `${short(current)} migrated the database beyond what ${short(previous)} can read; restore a pre-migrate backup to go back (see README, Maintenance)`,
      );
    this.switchTo(previous);
    this.state.pending = null;
    this.state.applied = { sha: previous, from: current, at: iso(this.now), notified: false };
    this.save();
    this.o.restart();
    return this.status();
  }

  private buildDir(sha: string): string {
    return join(this.buildsDir, dirName(sha));
  }

  /** Atomically repoints current at a build and keeps only it and the one before. */
  private switchTo(sha: string): void {
    const tmp = `${this.currentLink}.tmp`;
    rmSync(tmp, { force: true });
    symlinkSync(join("builds", dirName(sha)), tmp);
    renameSync(tmp, this.currentLink);
    if (this.state.current !== sha) this.state.previous = this.state.current;
    this.state.current = sha;
    this.save();
    void this.prune().catch((error: unknown) =>
      this.o.logger.warn({ err: error }, "pruning old OCD builds failed"),
    );
  }

  private async prune(): Promise<void> {
    const repoPath = this.sourcePath();
    const keep = new Set(
      [this.state.current, this.state.previous, this.state.pending?.sha, this.building]
        .filter((s): s is string => !!s)
        .map(dirName),
    );
    if (this.runningBuild) keep.add(this.runningBuild);
    for (const entry of readdirSync(this.buildsDir, { withFileTypes: true })) {
      const name = entry.name.replace(/\.log$/, "");
      if (keep.has(name)) continue;
      const path = join(this.buildsDir, entry.name);
      if (entry.isDirectory() && repoPath) await this.removeBuild(repoPath, path);
      else rmSync(path, { recursive: true, force: true });
    }
  }

  private async removeBuild(repoPath: string, dir: string): Promise<void> {
    if (existsSync(dir))
      await this.git.run(["worktree", "remove", "--force", dir], { cwd: repoPath });
    rmSync(dir, { recursive: true, force: true });
  }
}

function tail(output: string): string {
  return output.trim().split("\n").slice(-8).join("\n").slice(-500);
}

function migrations(buildDir: string): number {
  try {
    return readdirSync(join(buildDir, "packages/supervisor/drizzle")).filter((f) =>
      f.endsWith(".sql"),
    ).length;
  } catch {
    return 0;
  }
}

/** Runs a shell command in its own process group; the group is killed on timeout. */
function shell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-200_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/**
 * Starts the build's supervisor against a throwaway OCD_HOME (no harnesses,
 * no notifications) and waits for `ocd status` to answer, then stops it.
 */
export async function bootSmokeTest(buildDir: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ocd-smoke-"));
  const config = join(home, "ocd.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      ...Object.fromEntries(configurableHarnesses().map((h) => [h.name, { enabled: false }])),
      notifications: { enabled: false },
      backups: { intervalHours: 0 },
    }),
  );
  const cli = join(buildDir, "packages/cli/dist/ocd.mjs");
  const env = { ...process.env, OCD_HOME: home, OCD_CONFIG: config };
  const daemon = spawn(process.execPath, [cli, "daemon"], {
    cwd: home,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
  const exited = new Promise<number | null>((r) => daemon.on("close", (code) => r(code)));
  const status = () =>
    new Promise<boolean>((resolve) =>
      execFile(
        process.execPath,
        [cli, "status", "--json"],
        { cwd: home, env, timeout: 10_000 },
        (e) => resolve(!e),
      ),
    );
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (await status()) return;
      if (daemon.exitCode !== null || Date.now() > deadline)
        throw new Error(
          `the new version's supervisor did not start: ${tail(stderr) || "no output"}`,
        );
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    daemon.kill("SIGTERM");
    const stopped = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r("t"), 10_000)),
    ]);
    if (stopped === "t") daemon.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}
