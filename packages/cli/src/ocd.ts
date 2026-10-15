#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  OcdApiError,
  OcdClient,
  SupervisorUnavailableError,
  buildSpill,
  collectSpill,
  describeLandResult,
  describePendingUpdate,
  formatDiffStat,
  formatLandPlan,
  formatSpill,
  plainText,
  renderTranscript,
  resolveOcdPaths,
  updateLine,
  usageLines,
  type Attention,
  type AttentionResponse,
  type LandPlan,
  type MemoryScope,
  type Task,
} from "@ocd/core";
import {
  ConfigError,
  DatabaseTooNewError,
  GhPullRequests,
  probeGh,
  LockHeldError,
  SupervisorConfig,
  loadConfig,
  normalizeDirectory,
  startDaemon,
} from "@ocd/supervisor";

import { describeGh } from "./github.ts";
import { insideWorktree, serviceHomeProblem } from "./guard.ts";
import { buildAdapters, buildManagerChannel, doctorProblems, probeHarnesses } from "./harnesses.ts";
import {
  FallbackNotifier,
  currentPlatform,
  execCommand,
  servicePath,
  shellQuote,
  focusManager,
  iconAssets,
  locateBinary,
  loginShellPath,
  toolPath,
  type Platform,
} from "./platform/index.ts";
import { followInterval, followTranscript } from "./peek.ts";
import { addRepo, removeRepo } from "./repo-config.ts";
import { SetupStop, runSetup, systemSetupDeps, terminalPrompter } from "./setup.ts";

const HELP = `ocd — local agent control plane

Setup
  ocd setup [--yes]                 Set up (or check and repair) everything on this machine: prerequisites,
                                    ocd.jsonc, self-update, the manager directory and its plugin, \`ocd\` on
                                    PATH, the background service and notifications. Asks before each change
                                    outside ~/.ocd; --yes takes the defaults

Supervisor
  ocd daemon                        Run the supervisor in the foreground
  ocd service install [--force]|status|uninstall
                                    Run the supervisor in the background and at login
                                    (LaunchAgent on macOS, systemd user unit on Linux). install and uninstall
                                    (like restart) work only from the service's own home, never a worker sandbox;
                                    reinstalling a running service refuses while Claude Code / Codex workers run unless --force
  ocd stop                          Stop the supervisor and report worker outcomes
  ocd restart [--force]             Restart the background service (picks up a new build); refuses while
                                    Claude Code / Codex workers are running unless --force
  ocd status                        Show supervisor status
  ocd pause | ocd resume            Stop / restart new dispatch (running workers continue)
  ocd update [status|check|apply [--force]|rollback]
                                    OCD updating itself (selfUpdate in ocd.jsonc): show the state, look for and
                                    build a new version now, switch to the built one (--force interrupts Claude
                                    Code / Codex workers; asks first), or go back to the previous version
  ocd usage [--refresh]             Subscription usage limits Claude Code and Codex reported (usageLimits in
                                    ocd.jsonc); --refresh reads Codex's now (no tokens)
  ocd doctor [--notify]             Check harnesses, the OpenCode service, notifications, the service manager and
                                    the tools (git; gh and tmux when enabled) on the supervisor's PATH (your login shell's);
                                    --notify sends a test notification (click it to try \`ocd focus\`)
  ocd focus                         Switch to the manager session (tmux pane when tmux.enabled + terminal window); what a notification click runs

Configuration (human only)
  ocd repo list                     Repositories declared in ocd.jsonc
  ocd repo add <name> <path> [--profile P]
                                    Declare a repository in ocd.jsonc (comments are kept; applies live)
  ocd repo remove <name>            Remove it from ocd.jsonc (its tasks and worktrees are kept)
  ocd profile list                  Profiles declared in ocd.jsonc
  ocd manager                       Configured manager directory and active session

Tasks
  ocd spill                         Read-only summary of all open work: running, blocked, manual, stuck,
                                    queued and ready for review (/spill in the manager's TUI)
  ocd dispatch <repo> <title> --instructions TEXT [--profile P] [--criteria TEXT]... [--key KEY]
                                    (quote a multi-word title; extra words are rejected)
  ocd task list [--all] [--repo R]
  ocd task show <id>
  ocd task peek <id> [--limit N] [--before CURSOR] [--reasoning-summaries] [--follow [--interval SECONDS]]
                                    Read-only: the worker's recent assistant messages and tool calls/results
                                    (never prompts, resumes or changes it; untrusted output, secrets redacted).
                                    OpenCode: session history. Claude Code / Codex: what this supervisor saw,
                                    in memory only. --follow polls until the task leaves the running states
                                    (at most 30 min); --reasoning-summaries adds Codex reasoning summaries
  ocd task send <id> <instructions>
  ocd task cancel <id> [--reason TEXT]
  ocd task accept <id>
  ocd task resume <id> --mode reattach|relaunch
  ocd task takeover <id>            Manual mode: stop OCD driving the worker and print the command
                                    that opens its session (claude --resume, codex resume, opencode -s)
  ocd task giveback <id> --mode continue|review [--message NOTE]
                                    End manual mode: the worker continues headless, or the task goes to review
  ocd task pr <id> [--draft] [--base BRANCH] [--commit]
                                    Push the task branch and open a pull request (optional; never merges)
  ocd task merge <id> [--method squash|merge|rebase]
                                    Merge an accepted task's PR once checks pass (never overrides protection)
  ocd task land <id> [--commit] [--wait]
                                    Get the work into its base branch: accept, open or reuse the PR, merge it once
                                    checks pass, clean up. Run again to continue; --wait polls while checks run
  ocd task land <id> --direct       Escape hatch: push straight to the base branch (mergeMethod from ocd.jsonc,
                                    squash by default) after you confirm the exact commits; never forces
  ocd task diff <id> [--stat]       The task's changes against where its branch started (uncommitted ones too)
  ocd task request-changes <id> <feedback>
                                    Review feedback: the worker gets it as a follow-up and the task comes back
                                    for review; recorded as a numbered review round
  ocd task cleanup <id> [--force]   Remove a finished task's worktree and branch (refuses to lose work; work that
                                    is already in the base branch, e.g. squash-merged, counts as landed);
                                    --force loses work and asks first, like discard
  ocd task discard <id> [--reason TEXT]
                                    Cancel if needed and delete the worktree and branch, losing their work (asks first)

Attention
  ocd attention list [--all]
  ocd attention resolve <id> --approve | --deny [--message TEXT] | --answer TEXT | --ack

Memory
  ocd memory add <global|repo|task> <content> [--repo R] [--task T] [--proposed] [--supersedes ID]
  ocd memory search <query> [--repo R] [--task T] [--proposed]
  ocd memory list [--status proposed|confirmed|retired] [--repo R]
  ocd memory confirm <id> | ocd memory forget <id>
  ocd decision add <summary> [--repo R] [--task T] [--rationale TEXT]
  ocd briefing

Maintenance
  ocd outbox [--status pending|delivered|dead]

Global flags: --json  (machine-readable output)
Environment: OCD_HOME (default ~/.ocd), OCD_SOCKET, OCD_CONFIG (default $OCD_HOME/ocd.jsonc)
`;

/** How long `task land --wait` polls before giving up. */
const LAND_WAIT_LIMIT_MS = 60 * 60_000;
/** Exit status that tells launchd / systemd to start the service again (EX_TEMPFAIL). */
const EXIT_RESTART = 75;

const paths = resolveOcdPaths();
const client = new OcdClient({ socketPath: paths.socket, actor: "human" });
const platform: Platform = currentPlatform();

/** The built CLI, resolved through symlinks so services and click actions survive a relink. */
function cliPath(): string {
  return realpathSync(fileURLToPath(import.meta.url));
}

/**
 * The CLI path for things that outlive this process (the service definition,
 * notification clicks). Run from a self-update build, that is the stable
 * ~/.ocd/install/current link, so a switch to a new version takes effect on
 * the next start without rewriting them.
 */
function stableCliPath(home: string): string {
  const real = cliPath();
  const builds = join(home, "install", "builds") + sep;
  const current = join(home, "install", "current", "packages", "cli", "dist", "ocd.mjs");
  return real.startsWith(builds) && existsSync(current) ? current : real;
}

/** Notifications open the manager when clicked and carry OCD's icon. */
function notifierOptions() {
  return { onClick: focusCommand(), icon: iconAssets(import.meta.url), home: paths.home };
}

/** After a switch to a new version: OpenCode reloads its plugins (the OCD plugin runs from the install). */
function reloadOpenCode(): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile("opencode", ["reload"], { timeout: 30_000 }, (error, _out, stderr) =>
      error
        ? reject(new Error(`opencode reload: ${String(stderr).trim() || error.message}`))
        : resolve(),
    ),
  );
}

/**
 * What a notification click runs: `ocd focus` with this process's Node, state
 * directory and PATH (so it finds tmux). Notification daemons start it with a
 * bare environment, so they are passed explicitly.
 */
function focusCommand(): string[] {
  const env = (["OCD_HOME", "OCD_CONFIG", "PATH"] as const).flatMap((k) =>
    process.env[k] ? [`${k}=${process.env[k]}`] : [],
  );
  return ["/usr/bin/env", ...env, process.execPath, stableCliPath(paths.home), "focus"];
}

/**
 * The PATH the supervisor runs every tool with (gh, git, tmux, the harnesses):
 * the one the user's login shell sets up, so whatever installed a tool, it is
 * found without configuration. See platform/shell-env.ts.
 */
async function supervisorPath(inherited: string | undefined) {
  const login = await loginShellPath();
  return { login, path: toolPath({ login: login.path, inherited }) };
}

function print(value: unknown, json: boolean, render?: () => string): void {
  if (json || !render) console.log(JSON.stringify(value, null, 2));
  else console.log(render());
}

function fail(message: string): never {
  console.error(`ocd: ${message}`);
  process.exit(1);
}

function taskLine(t: Task): string {
  const sync = t.branchSync;
  const drift =
    sync?.state === "conflict"
      ? "  [base conflict]"
      : sync?.state === "behind"
        ? `  [${sync.behind} behind ${sync.baseRef}]`
        : "";
  return `${t.id}  ${t.state.padEnd(16)} ${t.repo.padEnd(14)} ${t.harness.padEnd(8)} ${plainText(t.title)}${drift}`;
}

function attentionLine(a: Attention): string {
  const target = a.taskId ? ` ${a.taskId}` : "";
  return `${a.id}  ${a.status.padEnd(8)} ${a.kind.padEnd(16)}${target}  [${a.resolvableBy}] ${plainText(a.reason)}`;
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  // Approvals need a person at a terminal, not a script or an agent's shell tool.
  // Prompts and plans go to stderr so --json output on stdout stays clean.
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(`${prompt} Type "approve" to confirm: `)).trim() === "approve";
  } catch {
    // Ctrl-C / Ctrl-D at the prompt (AbortError): not confirmed.
    return false;
  } finally {
    rl.close();
  }
}

/**
 * The background service is global (one LaunchAgent label / systemd unit), so
 * it is only managed from its own home, never from a worker's sandbox.
 */
function guardServiceHome(definitionPath: string): void {
  let definition: string | null = null;
  try {
    definition = readFileSync(definitionPath, "utf8");
  } catch {
    // not installed yet
  }
  const problem = serviceHomeProblem({ defaultHome: resolveOcdPaths({}).home, definition });
  if (problem) fail(problem);
}

/**
 * Supervisor-owned processes (Claude Code, Codex) are interrupted by a service
 * restart; OpenCode workers live in the OpenCode service and are reattached.
 */
async function interruptedWorkers(running: boolean): Promise<Task[]> {
  if (!running) return [];
  return (await client.listTasks({ open: true, limit: 200 })).filter(
    (t) =>
      t.harness !== "opencode" &&
      (t.state === "starting" || t.state === "running" || t.state === "blocked"),
  );
}

function refuseInterrupting(interrupted: Task[], what: string): void {
  fail(
    [
      `${what} would interrupt these workers (their sessions are kept for \`ocd task resume\`):`,
      ...interrupted.map((t) => `  ${t.id} ${t.harness} ${t.state} ${shown(t.title)}`),
      "wait for them, or pass --force",
    ].join("\n"),
  );
}

/** Worker-controlled text on a confirmation screen: no escape sequences or control characters. */
const shown = (text: string) => plainText(text);

async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    fail(`${(error as Error).message}\nRun \`ocd --help\` for usage.`);
  }
  const { values: flags, positionals } = parsed;
  return run(flags, positionals);
}

function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      background: { type: "boolean" },
      profile: { type: "string" },
      base: { type: "string" },
      instructions: { type: "string" },
      criteria: { type: "string", multiple: true },
      key: { type: "string" },
      all: { type: "boolean" },
      repo: { type: "string" },
      task: { type: "string" },
      reason: { type: "string" },
      mode: { type: "string" },
      approve: { type: "boolean" },
      force: { type: "boolean" },
      notify: { type: "boolean" },
      refresh: { type: "boolean" },
      method: { type: "string" },
      draft: { type: "boolean" },
      commit: { type: "boolean" },
      direct: { type: "boolean" },
      stat: { type: "boolean" },
      wait: { type: "boolean" },
      deny: { type: "boolean" },
      message: { type: "string" },
      answer: { type: "string" },
      ack: { type: "boolean" },
      proposed: { type: "boolean" },
      supersedes: { type: "string" },
      status: { type: "string" },
      rationale: { type: "string" },
      limit: { type: "string" },
      before: { type: "string" },
      "reasoning-summaries": { type: "boolean" },
      follow: { type: "boolean" },
      interval: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
}

async function run(
  flags: ReturnType<typeof parseCli>["values"],
  positionals: string[],
): Promise<void> {
  const json = flags.json ?? false;
  const [command, sub, ...rest] = positionals;
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }

  if (insideWorktree(process.cwd(), paths.workspaces)) {
    fail(
      [
        `refusing to use the live OCD from inside one of its worktrees (${process.cwd()}).`,
        "Workers get a sandbox OCD_HOME; to try OCD here, use a scratch home:",
        '  OCD_HOME="$(mktemp -d)" ocd daemon',
        `To act on the live OCD from here anyway, say so: OCD_HOME=${paths.home} ocd …`,
      ].join("\n"),
    );
  }

  switch (command) {
    case "setup": {
      const yes = flags.yes ?? false;
      if (!yes && !(process.stdin.isTTY && process.stdout.isTTY))
        fail("setup asks questions; run it in a terminal, or pass --yes to take the defaults");
      const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
      const say = (line: string) => console.log(line);
      try {
        const { problems } = await runSetup(
          systemSetupDeps({
            home: homedir(),
            ocdHome: paths.home,
            configPath: paths.config,
            platform: platform.name,
            cliPath: cliPath(),
            service: platform.service,
            locate: (name) => locateBinary(name),
            loginPath: async () => (await loginShellPath()).path,
            prompt: terminalPrompter(rl, say),
            say,
          }),
        );
        if (problems.length) process.exitCode = 1;
      } catch (error) {
        // Ctrl-C / Ctrl-D at a prompt: stop quietly; re-running picks up where it stopped.
        if (error instanceof SetupStop || (error as Error).name === "AbortError")
          fail("setup stopped");
        throw error;
      } finally {
        rl?.close();
      }
      return;
    }
    case "daemon": {
      const background = flags.background ?? false;
      // Before anything is spawned: workers, gh and notifications inherit it.
      const tools = await supervisorPath(process.env["PATH"]);
      process.env["PATH"] = tools.path;
      if (tools.login.error)
        console.error(
          `ocd: could not read your login shell's PATH (${tools.login.error}); using the inherited PATH and common install locations`,
        );
      let daemon: Awaited<ReturnType<typeof startDaemon>>;
      try {
        daemon = await startDaemon({
          paths,
          foreground: !background,
          adapters: buildAdapters,
          managerChannel: buildManagerChannel,
          pullRequests: ({ config }) => (config.github.enabled ? new GhPullRequests() : undefined),
          notifier: await platform.notifier(notifierOptions()),
          selfUpdate: {
            runningFrom: cliPath(),
            service: background,
            afterApplied: {
              run: reloadOpenCode,
              failed: {
                headline: "OpenCode did not reload OCD's plugin",
                detail: "OpenCode still has the previous plugin. Run `opencode reload`.",
              },
            },
          },
        });
      } catch (error) {
        if (
          background &&
          (error instanceof LockHeldError ||
            error instanceof DatabaseTooNewError ||
            error instanceof ConfigError)
        ) {
          // Under launchd a clean exit avoids a restart loop; tell the human instead.
          console.error(`ocd: not started: ${error.message}`);
          await (
            await platform.notifier({ ...notifierOptions(), onClick: undefined })
          )
            .notify({ title: "OCD: Supervisor not started", body: error.message })
            .catch(() => undefined);
          process.exit(0);
        }
        throw error;
      }
      const shutdown = () => {
        void daemon.stop().then((report) => {
          console.error(`ocd: stopped. ${report.workerPolicy}`);
          for (const w of report.workers)
            console.error(`  ${w.taskId} (${w.harness}): ${w.outcome}`);
          process.exit(0);
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      const report = await daemon.closed;
      if (report) {
        console.error(`ocd: stopped. ${report.workerPolicy}`);
        for (const w of report.workers) console.error(`  ${w.taskId} (${w.harness}): ${w.outcome}`);
      }
      // A non-zero exit makes launchd / systemd start the service again, now on the new version.
      if (daemon.restartRequested) console.error("ocd: restarting for an update");
      process.exit(daemon.restartRequested ? EXIT_RESTART : 0);
      return;
    }
    case "service":
    case "launchagent": {
      const service = platform.service;
      if (!service)
        fail(`no background service manager for ${process.platform}; run \`ocd daemon\` instead`);
      if (sub === "install" || sub === "uninstall") {
        guardServiceHome((await service.status()).definition);
      }
      if (sub === "install") {
        const status = await client.status().catch(() => null);
        const current = await service.status();
        if (status && !current.loaded) {
          fail(
            `a supervisor is already running (pid ${status.pid}); stop it with \`ocd stop\` first`,
          );
        }
        // Replacing a loaded definition restarts the supervisor, like `ocd restart`.
        const interrupted = current.loaded ? await interruptedWorkers(status !== null) : [];
        if (interrupted.length && !flags.force)
          refuseInterrupting(interrupted, "reinstalling the service");
        const { definition } = await service.install({
          nodePath: process.execPath,
          cliPath: stableCliPath(paths.home),
          logsDir: paths.logs,
          env: { OCD_HOME: process.env["OCD_HOME"], OCD_CONFIG: process.env["OCD_CONFIG"] },
        });
        print(
          { definition, manager: service.kind },
          json,
          () =>
            `installed ${definition}; the supervisor now runs in the background (${service.kind}) and starts at login`,
        );
      } else if (sub === "uninstall") {
        const r = await service.uninstall();
        print(r, json, () =>
          r.removed
            ? "background service removed; the supervisor is stopped"
            : "no background service installed",
        );
      } else if (sub === "status" || sub === undefined) {
        const s = await service.status();
        print(s, json, () =>
          [
            `definition: ${s.installed ? s.definition : "not installed"}`,
            `${s.manager}: ${s.loaded ? `${s.state ?? "loaded"}${s.pid ? ` (pid ${s.pid})` : ""}${s.lastExitCode ? `, last exit ${s.lastExitCode}` : ""}` : "not loaded"}`,
            `logs: ${paths.logs}`,
          ].join("\n"),
        );
      } else fail("usage: ocd service install|status|uninstall");
      return;
    }
    case "focus": {
      let directory: string | null = null;
      let focusApp: string | undefined;
      let tmux = false;
      try {
        const config = loadConfig(paths.config);
        directory = config.manager ? normalizeDirectory(config.manager.directory) : null;
        focusApp = config.notifications.focusApp;
        tmux = config.tmux.enabled;
      } catch {
        // An invalid config focuses nothing; the click must not fail loudly.
      }
      const steps = await focusManager({
        directory,
        tmux: tmux ? locateBinary("tmux") : null,
        focusApp,
        exec: execCommand,
        activate: (app) => platform.activate(app),
      });
      print({ steps }, json, () => steps.join("\n"));
      return;
    }
    case "restart": {
      const service = platform.service;
      if (service) guardServiceHome((await service.status()).definition);
      const before = await client.status().catch(() => null);
      const current = service ? await service.status() : null;
      if (!service || !current?.loaded) {
        fail(
          before
            ? `the supervisor (pid ${before.pid}) is not running as a background service; stop it with Ctrl-C or \`ocd stop\` and start \`ocd daemon\` again, or use \`ocd service install\``
            : "no background service installed; run `ocd daemon` or `ocd service install`",
        );
      }
      const interrupted = await interruptedWorkers(before !== null);
      if (interrupted.length && !flags.force) refuseInterrupting(interrupted, "a restart");
      await service.restart();
      // Wait for the new instance to answer on the socket.
      const deadline = Date.now() + 30_000;
      let after: Awaited<ReturnType<typeof client.status>> | null = null;
      while (Date.now() < deadline) {
        after = await client.status().catch(() => null);
        if (after && after.instanceId !== before?.instanceId) break;
        after = null;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!after)
        fail(
          `restarted via ${service.kind}, but the supervisor did not answer within 30s; see ${paths.logs}`,
        );
      print(
        { before: before?.pid ?? null, after: after.pid, instanceId: after.instanceId },
        json,
        () =>
          [
            `restarted (${service.kind}): pid ${before?.pid ?? "-"} → ${after.pid}`,
            ...(interrupted.length
              ? [
                  `interrupted: ${interrupted.map((t) => t.id).join(", ")} (resume with \`ocd task resume\`)`,
                ]
              : []),
          ].join("\n"),
      );
      return;
    }
    case "stop": {
      const report = await client.shutdown();
      print(report, json, () =>
        [
          report.workerPolicy,
          ...report.workers.map((w) => `  ${w.taskId} (${w.harness}): ${w.outcome}`),
        ].join("\n"),
      );
      return;
    }
    case "status": {
      const s = await client.status();
      print(s, json, () =>
        [
          `supervisor ${s.instanceId} pid ${s.pid} since ${s.startedAt} (API v${s.apiVersion})`,
          `dispatch: ${s.paused ? "PAUSED" : "active"}, concurrency ${s.concurrency}`,
          `tasks: ${
            Object.entries(s.counts)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ") || "none"
          }`,
          `attention: ${s.openAttention} open; outbox: ${s.outbox.pending} pending (${s.outbox.failed} retrying), ${s.outbox.dead} dead`,
          `manager: ${s.manager ? `${s.manager.sessionId} (${s.manager.directory})` : "no active session"}`,
          ...s.adapters.map(
            (a) =>
              `harness ${a.harness}: ${a.available ? `ok ${a.version ?? ""}` : `UNAVAILABLE ${a.problems.join("; ")}`}`,
          ),
          ...(s.github ? [`github (gh): ${describeGh(s.github)}`] : []),
          ...(updateLine(s.update) ? [`update: ${updateLine(s.update)}`] : []),
          ...usageLines(s.usage?.harnesses ?? [], Date.now()).map((line) => `usage: ${line}`),
        ].join("\n"),
      );
      return;
    }
    case "usage": {
      const u = flags.refresh ? await client.refreshUsage() : await client.usage();
      print(u, json, () =>
        u.harnesses.length
          ? [
              ...usageLines(u.harnesses, Date.now()),
              u.notifyAt.length
                ? `Notifies at ${u.notifyAt.map((n) => `${n}%`).join(" and ")} of a window, and when a limit is reached.`
                : "Notifies only when a limit is reached (usageLimits.notifyAt is empty).",
            ].join("\n")
          : "No usage limits reported yet: Claude Code reports them while a worker runs, Codex when it is enabled (ocd usage --refresh reads it now).",
      );
      return;
    }
    case "spill": {
      const snapshot = buildSpill(await collectSpill(client));
      print(snapshot, json, () => formatSpill(snapshot));
      return;
    }
    case "update": {
      if (sub === "status" || sub === undefined) {
        const u = await client.updateStatus();
        print(u, json, () =>
          u?.enabled
            ? describePendingUpdate(u)
            : "Self-update is off (selfUpdate.enabled in ocd.jsonc)",
        );
      } else if (sub === "check") {
        const u = await client.checkUpdate();
        print(u, json, () => describePendingUpdate(u));
      } else if (sub === "apply") {
        const before = await client.updateStatus();
        if (!before?.pending) fail("no update is pending (`ocd update check` looks for one)");
        if (before.blockedBy.length && !flags.force)
          fail(
            `${describePendingUpdate(before)}\nIt is applied automatically once they finish; --force applies it now.`,
          );
        if (before.blockedBy.length) {
          console.error(describePendingUpdate(before));
          if (!(await confirmInteractive("Interrupt them and update now?")))
            fail("not applied (confirming needs an interactive terminal)");
        }
        const u = await client.applyUpdate(flags.force ?? false);
        print(u, json, () =>
          u.pending ? describePendingUpdate(u) : "switching versions; the supervisor restarts",
        );
      } else if (sub === "rollback") {
        const u = await client.rollbackUpdate();
        print(u, json, () => `going back to ${u.current?.slice(0, 7)}; the supervisor restarts`);
      } else fail("usage: ocd update [status|check|apply [--force]|rollback]");
      return;
    }
    case "pause":
    case "resume": {
      const r = command === "pause" ? await client.pause() : await client.resume();
      print(r, json, () => `dispatch ${r.paused ? "paused" : "resumed"}`);
      return;
    }
    case "doctor": {
      // Check with the PATH the supervisor would have, not this shell's.
      const tools = await supervisorPath(
        platform.service ? servicePath(process.execPath) : process.env["PATH"],
      );
      process.env["PATH"] = tools.path;
      // Optional tools are checked only when ocd.jsonc turns them on.
      let configError: string | null = null;
      let config: SupervisorConfig;
      try {
        config = loadConfig(paths.config);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
        config = SupervisorConfig.parse({});
      }
      const harnesses = await probeHarnesses(config);
      const gh = config.github.enabled ? await probeGh({ timeoutMs: 10_000 }) : null;
      const git = locateBinary("git");
      const notifier = await platform.notifier(notifierOptions());
      const tmux = config.tmux.enabled ? locateBinary("tmux") : null;
      let delivery: string | null = null;
      if (flags.notify) {
        try {
          await notifier.notify({
            title: "OCD: Test notification",
            body: notifier.clickable ? "Click to jump to the manager session" : "Delivered",
          });
          const fellBack = notifier instanceof FallbackNotifier ? notifier.lastError : null;
          delivery = fellBack
            ? `sent with the fallback (not clickable): ${fellBack.message}`
            : "sent";
        } catch (error) {
          delivery = `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const report = {
        config: { path: paths.config, error: configError },
        harnesses,
        github: gh,
        path: { value: tools.path, shell: tools.login.shell, error: tools.login.error },
        git,
        platform: {
          name: platform.name,
          notifications: { backend: notifier.backend, clickable: notifier.clickable, delivery },
          tmux,
          service: platform.service?.kind ?? null,
        },
      };
      print(report, json, () => {
        const hints: string[] = [];
        if (platform.name === "macos" && !notifier.clickable)
          hints.push(
            "  brew install terminal-notifier  # makes notifications open the manager session",
          );
        if (platform.name === "linux" && !notifier.clickable)
          hints.push(
            "  libnotify 0.7.9+ (notify-send --action) makes notifications open the manager session",
          );
        const off = (key: string) => `off (turn on with ${key}.enabled in ocd.jsonc)`;
        const harnessOff = (["opencode", "claude", "codex"] as const)
          .filter((h) => !config[h].enabled)
          .map((h) => {
            const users = Object.entries(config.profiles)
              .filter(([, profile]) => profile.harness === h)
              .map(([name]) => name);
            const note = users.length ? `; profiles ${users.join(", ")} cannot run` : "";
            return `${h.padEnd(9)} ${off(h)}${note}`;
          });
        return [
          ...(configError ? [`${"config".padEnd(9)} INVALID ${configError}`] : []),
          ...harnesses.map(
            (r) =>
              `${r.harness.padEnd(9)} ${r.available ? "ok" : "--"} ${r.version ?? ""} ${r.problems.join("; ")}`,
          ),
          ...harnessOff,
          `${"notify".padEnd(9)} ${notifier.backend}${notifier.clickable ? ", click opens the manager" : ", not clickable"}`,
          ...(delivery ? [`${"".padEnd(9)} test notification ${delivery}`] : []),
          `${"tmux".padEnd(9)} ${config.tmux.enabled ? (tmux ?? "not found on PATH") : off("tmux")}`,
          `${"service".padEnd(9)} ${platform.service?.kind ?? "none"} (${platform.name})`,
          `${"gh".padEnd(9)} ${gh ? describeGh(gh) : off("github")}`,
          `${"git".padEnd(9)} ${git ?? "not found (worktrees need git)"}`,
          `${"PATH".padEnd(9)} ${tools.login.error ? `login shell not readable (${tools.login.error}); common install locations only` : `from your login shell (${tools.login.shell})`}`,
          ...hints,
        ].join("\n");
      });
      const problems = doctorProblems({
        configError,
        git,
        harnesses,
        github: { enabled: config.github.enabled, available: gh?.available ?? null },
        tmux: { enabled: config.tmux.enabled, path: tmux },
      });
      if (problems.length) {
        console.error(`ocd doctor: ${problems.join("; ")}`);
        process.exitCode = 1;
      }
      return;
    }
    case "repo": {
      if (sub === "add" || sub === "remove") {
        const [name, path] = rest;
        if (!name || (sub === "add" && !path))
          fail("usage: ocd repo add <name> <path> [--profile P] | ocd repo remove <name>");
        try {
          if (sub === "add") addRepo(paths.config, name, path!, flags.profile);
          else removeRepo(paths.config, name);
        } catch (error) {
          fail((error as Error).message);
        }
        // The supervisor hot-reloads ocd.jsonc; confirm it took effect.
        const want = sub === "add";
        let applied: boolean | null = null;
        for (let i = 0; i < 20 && applied !== true; i++) {
          const repos = await client.listRepos().catch(() => null);
          if (!repos) break;
          applied = repos.some((r) => r.name === name) === want;
          if (!applied) await new Promise((r) => setTimeout(r, 250));
        }
        print({ name, applied }, json, () =>
          applied === null
            ? `${want ? "added" : "removed"} ${name} in ${paths.config}; the supervisor is not running and loads it on start`
            : applied
              ? `${want ? "added" : "removed"} ${name}${want ? "" : " (its tasks and worktrees are kept)"}`
              : `${want ? "added" : "removed"} ${name} in ${paths.config}, but the supervisor has not applied it yet; check \`ocd status\` and ${paths.logs}`,
        );
        return;
      }
      if (sub !== "list" && sub !== undefined) fail("usage: ocd repo list|add|remove");
      const repos = await client.listRepos();
      print(
        repos,
        json,
        () =>
          repos
            .map(
              (r) =>
                `${r.name.padEnd(16)} ${r.path}  profile=${r.defaultProfile ?? "-"}${r.baseRef ? ` base=${r.baseRef}` : ""}`,
            )
            .join("\n") || `no repositories; declare them under repos in ${paths.config}`,
      );
      return;
    }
    case "profile": {
      if (sub !== "list" && sub !== undefined)
        fail(`profiles are declared in ${paths.config}; saved changes apply automatically`);
      const profiles = await client.listProfiles();
      print(
        profiles,
        json,
        () =>
          profiles
            .map(
              (p) =>
                `${p.name.padEnd(16)} ${p.harness.padEnd(9)} ${p.model}  agent=${p.agent ?? "-"} permissions=${p.permissionPolicy}${p.description ? `\n${" ".repeat(18)}${p.description}` : ""}`,
            )
            .join("\n") || `no profiles; declare them in ${paths.config}`,
      );
      return;
    }
    case "manager": {
      const m = await client.getManager();
      print(m, json, () =>
        [
          `directory: ${m.directory ?? `not configured (set manager.directory in ${paths.config})`}`,
          `active session: ${m.active ? `${m.active.sessionId} since ${m.active.activatedAt}` : "none yet (start OpenCode in the manager directory)"}`,
        ].join("\n"),
      );
      return;
    }
    case "dispatch": {
      const [repo, title] = [sub, rest[0]];
      if (!repo || !title || !flags.instructions)
        fail("usage: ocd dispatch <repo> <title> --instructions TEXT");
      if (rest.length > 1)
        fail(
          `unexpected extra words after the title: ${rest.slice(1).join(" ")}\nQuote a multi-word title: ocd dispatch ${repo} "${rest.join(" ")}" --instructions …`,
        );
      const r = await client.dispatch({
        repo,
        title,
        instructions: flags.instructions,
        acceptanceCriteria: flags.criteria ?? [],
        idempotencyKey: flags.key ?? `cli-${Date.now()}-${process.pid}`,
        ...(flags.profile ? { profile: flags.profile } : {}),
      });
      print(r, json, () => `${r.created ? "queued" : "already exists"}: ${taskLine(r.task)}`);
      return;
    }
    case "task": {
      const id = rest[0];
      if (sub === "list") {
        const tasks = await client.listTasks({
          ...(flags.all ? {} : { open: true }),
          ...(flags.repo ? { repo: flags.repo } : {}),
        });
        print(tasks, json, () => tasks.map(taskLine).join("\n") || "no tasks");
        return;
      }
      if (!id) fail(`usage: ocd task ${sub ?? "<command>"} <id>`);
      if (sub === "show") {
        const d = await client.inspectTask(id);
        print(d, json, () =>
          [
            taskLine(d.task),
            `workspace: ${d.task.workspacePath ?? "-"} (branch ${d.task.branch ?? "-"}, base ${d.task.baseRef ?? "-"})`,
            `session: ${d.task.sessionId ?? "-"}  attempts: ${d.task.attempts}`,
            d.task.pullRequestUrl ? `pull request: ${d.task.pullRequestUrl}` : "",
            d.task.branchSync
              ? `branch sync: ${d.task.branchSync.state} (checked ${d.task.branchSync.checkedAt}) ${d.task.branchSync.reason}`
              : "",
            d.task.error ? `error: ${d.task.error}` : "",
            d.task.result?.reported
              ? `reported: ${d.task.result.reported.summary}`
              : d.task.result?.reportError
                ? `report: ${d.task.result.reportError}`
                : "",
            d.task.result?.verification
              ? `verified changed files: ${d.task.result.verification.changedFiles.join(", ") || "none"}`
              : "",
            ((rounds) => (rounds ? `review: changes requested ${rounds}×` : ""))(
              d.events.filter((e) => e.type === "review.changes_requested").length,
            ),
            "",
            "attention:",
            ...d.attention.map((a) => `  ${attentionLine(a)}`),
            "events:",
            ...d.events.slice(-15).map((e) => `  ${e.createdAt} ${e.type}`),
          ]
            .filter((l) => l !== "")
            .join("\n"),
        );
      } else if (sub === "peek") {
        const limit = flags.limit === undefined ? undefined : Number(flags.limit);
        if (limit !== undefined && !Number.isInteger(limit)) fail("--limit takes a whole number");
        const reasoningSummaries = flags["reasoning-summaries"] ?? false;
        if (flags.follow) {
          if (flags.before)
            fail("--follow reads the latest entries; it cannot start --before a cursor");
          let interval: number;
          try {
            interval = followInterval(flags.interval);
          } catch (error) {
            fail((error as Error).message);
          }
          const stop = new AbortController();
          process.once("SIGINT", () => stop.abort());
          const r = await followTranscript(
            () => client.peekTask(id, { limit: limit ?? 50, reasoningSummaries }),
            {
              intervalMs: interval,
              signal: stop.signal,
              json,
              write: (line) => console.log(line),
              // Headers, notes and retries are not entries: keep stdout clean for --json.
              note: (line) => console.error(line),
            },
          );
          if (r.end === "errors" || r.end === "unavailable") fail(`stopped following: ${r.detail}`);
          if (!json) console.error(`(stopped following: ${r.detail})`);
          return;
        }
        const t = await client.peekTask(id, {
          ...(limit !== undefined ? { limit } : {}),
          ...(flags.before ? { before: flags.before } : {}),
          reasoningSummaries,
        });
        print(t, json, () => `${t.notice}\n${renderTranscript(t)}`);
      } else if (sub === "send") {
        const text = rest.slice(1).join(" ");
        if (!text) fail("usage: ocd task send <id> <instructions>");
        print(await client.sendToWorker(id, text), json, () => `sent to ${id}`);
      } else if (sub === "cancel") {
        const t = await client.cancelTask(id, flags.reason);
        print(t, json, () => `cancelled ${id}; workspace preserved at ${t.workspacePath ?? "-"}`);
      } else if (sub === "accept") {
        print(await client.acceptTask(id), json, () => `accepted ${id} as completed`);
      } else if (sub === "merge") {
        const method = flags.method;
        if (
          method !== undefined &&
          method !== "squash" &&
          method !== "merge" &&
          method !== "rebase"
        ) {
          fail("--method must be squash, merge or rebase");
        }
        const t = await client.mergePullRequest(id, method);
        const merged = (await client.inspectTask(id)).events.some(
          (e) => e.type === "pull_request.merged",
        );
        print(t, json, () =>
          merged
            ? `merged ${t.pullRequestUrl}; worktree and branches removed`
            : `merge requested for ${t.pullRequestUrl} (queued)`,
        );
      } else if (sub === "diff") {
        const d = await client.taskDiff(id);
        print(d, json, () =>
          flags.stat ? formatDiffStat(d) : `${formatDiffStat(d)}\n\n${d.patch}`,
        );
      } else if (sub === "request-changes") {
        const feedback = rest.slice(1).join(" ");
        if (!feedback) fail("usage: ocd task request-changes <id> <feedback>");
        const t = await client.requestChanges(id, feedback);
        print(t, json, () => `sent the feedback to ${id}; it is ${t.state} again`);
      } else if (sub === "land") {
        const ignored = (names: readonly (keyof typeof flags)[]) => {
          const given = names.filter((n) => flags[n] !== undefined);
          if (given.length)
            fail(
              `${given.map((n) => `--${n}`).join(", ")} ${given.length === 1 ? "does" : "do"} not apply to \`ocd task land\`${flags.direct ? " --direct" : ""}`,
            );
        };
        if (flags.direct) {
          ignored(["commit", "wait", "base", "method", "draft"]);
          const plan = await client.landPlan(id);
          if (plan.blocker) fail(`${plan.blocker.message} (${plan.blocker.code})`);
          console.error(formatLandPlan(plan));
          if (!(await confirmInteractive("Push it?")))
            fail("not pushed (confirming needs an interactive terminal)");
          const r = await client.landTask(id, { direct: true, confirm: plan.head });
          print(r, json, () => describeLandResult(r));
          return;
        }
        ignored(["base", "method", "draft"]);
        const commit = flags.commit ?? false;
        let r = await client.landTask(id, { commit });
        if (!json) console.log(describeLandResult(r));
        // Only states that resolve on their own are worth waiting for.
        const waitable = new Set(["pr_checks_pending", "pr_not_ready", "merge_queued"]);
        const waitUntil = Date.now() + LAND_WAIT_LIMIT_MS;
        while (flags.wait && r.waiting && waitable.has(r.waiting.code)) {
          if (Date.now() >= waitUntil) {
            console.error(
              `ocd: stopped waiting after ${LAND_WAIT_LIMIT_MS / 60_000} minutes; run \`ocd task land ${id} --wait\` again to continue`,
            );
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          const before = r.waiting.message;
          r = await client.landTask(id, { commit });
          if (!json && (r.landed || r.waiting?.message !== before))
            console.log(describeLandResult(r));
        }
        if (json) print(r, json);
        if (!r.landed) process.exitCode = 2;
      } else if (sub === "discard") {
        const t = (await client.inspectTask(id)).task;
        console.error(
          `Discard "${shown(t.title)}" (${t.id}, ${t.state})? ${t.state === "completed" || t.state === "cancelled" ? "Its" : "It is cancelled, then its"} worktree and branch are deleted, including uncommitted changes and commits that exist nowhere else.${t.workspacePath ? `\n  ${shown(t.workspacePath)}` : ""}`,
        );
        if (!(await confirmInteractive("Discard it?")))
          fail("not discarded (confirming needs an interactive terminal)");
        const d = await client.discardTask(id, flags.reason);
        print(d, json, () => `discarded ${id}`);
      } else if (sub === "cleanup") {
        if (flags.force) {
          // --force skips the supervisor's lost-work check: as destructive as discard.
          const d = (await client.inspectTask(id)).task;
          console.error(
            `Force-clean "${shown(d.title)}" (${d.id}, ${d.state})? Its worktree and branch are deleted even if that loses work: uncommitted changes and commits that exist nowhere else.${d.workspacePath ? `\n  ${shown(d.workspacePath)}` : ""}`,
          );
          if (!(await confirmInteractive("Force the cleanup?")))
            fail("not cleaned up (confirming needs an interactive terminal)");
        }
        const t = await client.cleanupTask(id, flags.force ?? false);
        print(t, json, () => `removed the worktree and branch of ${id}`);
      } else if (sub === "pr") {
        const t = await client.openPullRequest(id, {
          draft: flags.draft ?? false,
          commit: flags.commit ?? false,
          ...(flags.base ? { base: flags.base } : {}),
        });
        print(t, json, () => `pull request: ${t.pullRequestUrl}`);
      } else if (sub === "resume") {
        if (flags.mode !== "reattach" && flags.mode !== "relaunch")
          fail("--mode reattach|relaunch is required");
        print(await client.resumeTask(id, flags.mode), json, () => `resumed ${id} (${flags.mode})`);
      } else if (sub === "takeover") {
        const r = await client.takeOverTask(id);
        print(r, json, () =>
          [
            `${id} is in manual mode: OCD stopped driving it and the manager was told to leave it alone.`,
            "Drive the session yourself (in tmux it keeps running after you close the terminal):",
            `  cd ${shellQuote([r.cwd])} && env ${shellQuote(Object.entries(r.env).map(([k, v]) => `${k}=${v}`))} ${shellQuote(r.command)}`,
            `Hand it back with: ocd task giveback ${id} --mode continue|review [--message NOTE]`,
          ].join("\n"),
        );
      } else if (sub === "giveback") {
        if (flags.mode !== "continue" && flags.mode !== "review")
          fail("--mode continue|review is required");
        const t = await client.giveBackTask(id, {
          mode: flags.mode,
          ...(flags.message ? { note: flags.message } : {}),
        });
        print(t, json, () =>
          flags.mode === "continue"
            ? `handed ${id} back; the worker continues`
            : `handed ${id} back; it is ready for review`,
        );
      } else
        fail(
          "usage: ocd task list|show|peek|diff|send|request-changes|cancel|accept|land|pr|merge|cleanup|discard|resume|takeover|giveback",
        );
      return;
    }
    case "attention": {
      if (sub === "list" || !sub) {
        const items = await client.listAttention(flags.all ? {} : { status: "open" });
        print(items, json, () => items.map(attentionLine).join("\n") || "nothing needs attention");
        return;
      }
      if (sub === "resolve") {
        const id = rest[0];
        if (!id) fail("usage: ocd attention resolve <id> --approve|--deny|--answer TEXT|--ack");
        let response: AttentionResponse;
        if (flags.approve) {
          // Look the item up before approving; an unknown item is never approved blind.
          // (The API lists at most 200 per call and cannot fetch one by id.)
          const open = await client.listAttention({ status: "open", limit: 200 });
          let item = open.find((a) => a.id === id);
          if (!item) {
            const any = (await client.listAttention({ limit: 200 })).find((a) => a.id === id);
            fail(
              any
                ? `${id} is ${any.status}, not open; nothing to approve`
                : `attention item ${id} was not found among the latest ${open.length >= 200 ? "200 open" : "open"} items; refusing to approve it unseen (see \`ocd attention list --all\`)`,
            );
          }
          const NO_CONFIRMATION = new Set(["decision", "review", "question", "stall", "failure"]);
          if (item.kind === "permission") {
            console.error(`Permission request from ${item.taskId}: ${shown(item.reason)}`);
            console.error(`Operation: ${shown(JSON.stringify(item.operation))}`);
            if (!(await confirmInteractive("Approve this operation?")))
              fail("not approved (an interactive terminal is required)");
          } else if (item.kind === "land") {
            if (!item.taskId)
              fail(`${id} is a land request without a task; refusing to approve it`);
            const plan = await client.landPlan(item.taskId);
            const asked = item.operation as LandPlan;
            if (plan.blocker) fail(`${plan.blocker.message} (${plan.blocker.code})`);
            if (plan.head !== asked.head)
              fail("the task branch moved since the manager asked; deny this and ask again");
            console.error(`The manager asks to push directly:\n${formatLandPlan(asked)}`);
            if (!(await confirmInteractive("Push it?")))
              fail("not approved (an interactive terminal is required)");
          } else if (!NO_CONFIRMATION.has(item.kind)) {
            // A kind this CLI does not know how to present: show it, and confirm.
            console.error(`${shown(item.kind)} request: ${shown(item.reason)}`);
            console.error(`Operation: ${shown(JSON.stringify(item.operation))}`);
            if (!(await confirmInteractive("Approve it?")))
              fail("not approved (an interactive terminal is required)");
          }
          response = { type: "approve" };
        } else if (flags.deny)
          response = { type: "deny", ...(flags.message ? { message: flags.message } : {}) };
        else if (flags.answer) response = { type: "answer", text: flags.answer };
        else if (flags.ack)
          response = { type: "acknowledge", ...(flags.message ? { note: flags.message } : {}) };
        else fail("choose --approve, --deny, --answer TEXT, or --ack");
        const a = await client.resolveAttention(id, response);
        print(a, json, () => `${a.id} ${a.status}`);
        return;
      }
      fail("usage: ocd attention list|resolve");
      return;
    }
    case "memory": {
      if (sub === "add") {
        const [scope, ...words] = rest;
        if (!scope || words.length === 0)
          fail("usage: ocd memory add <global|repo|task> <content>");
        const m = await client.remember({
          scope: scope as MemoryScope,
          content: words.join(" "),
          source: flags.proposed ? "manager" : "human",
          ...(flags.repo ? { repo: flags.repo } : {}),
          ...(flags.task ? { taskId: flags.task } : {}),
          ...(flags.supersedes ? { supersedes: flags.supersedes } : {}),
        });
        print(m, json, () => `${m.id} ${m.status} (${m.scope}${m.repo ? `:${m.repo}` : ""})`);
      } else if (sub === "search") {
        const query = rest.join(" ");
        if (!query) fail("usage: ocd memory search <query>");
        const hits = await client.recall({
          query,
          ...(flags.repo ? { repo: flags.repo } : {}),
          ...(flags.task ? { taskId: flags.task } : {}),
          includeProposed: flags.proposed ?? false,
        });
        print(
          hits,
          json,
          () =>
            hits
              .map(
                (h) =>
                  `${h.memory.id} [${h.memory.scope}${h.memory.repo ? `:${h.memory.repo}` : ""}] ${h.snippet}`,
              )
              .join("\n") || "no matches",
        );
      } else if (sub === "list") {
        const items = await client.listMemories({
          ...(flags.status ? { status: flags.status } : {}),
          ...(flags.repo ? { repo: flags.repo } : {}),
        });
        print(
          items,
          json,
          () =>
            items
              .map(
                (m) =>
                  `${m.id} ${m.status.padEnd(9)} [${m.scope}${m.repo ? `:${m.repo}` : ""}] ${m.content}`,
              )
              .join("\n") || "no memories",
        );
      } else if (sub === "confirm" && rest[0]) {
        print(await client.confirmMemory(rest[0]), json, () => `confirmed ${rest[0]}`);
      } else if (sub === "forget" && rest[0]) {
        print(await client.forget(rest[0]), json, () => `forgot ${rest[0]}`);
      } else fail("usage: ocd memory add|search|list|confirm|forget");
      return;
    }
    case "decision": {
      const summary = rest.join(" ");
      if (sub !== "add" || !summary) fail("usage: ocd decision add <summary>");
      const d = await client.recordDecision({
        summary,
        ...(flags.rationale ? { rationale: flags.rationale } : {}),
        ...(flags.repo ? { repo: flags.repo } : {}),
        ...(flags.task ? { taskId: flags.task } : {}),
      });
      print(d, json, () => `recorded ${d.id}`);
      return;
    }
    case "briefing": {
      const b = await client.briefing();
      print(b, json, () => b.text);
      return;
    }
    case "outbox": {
      const entries = await client.listOutbox(flags.status ? { status: flags.status } : {});
      print(
        entries,
        json,
        () =>
          entries
            .map(
              (e) =>
                `${e.id} ${e.status.padEnd(9)} ${e.kind.padEnd(12)} attempts=${e.attempts} ${e.lastError ?? ""}`,
            )
            .join("\n") || "outbox empty",
      );
      return;
    }
    default:
      fail(`unknown command ${command}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof SupervisorUnavailableError ||
    error instanceof LockHeldError ||
    error instanceof DatabaseTooNewError ||
    error instanceof ConfigError
  ) {
    fail(error.message);
  }
  if (error instanceof OcdApiError) fail(`${error.message} (${error.code})`);
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
