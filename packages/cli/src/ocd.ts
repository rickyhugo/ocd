#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  OcdApiError,
  OcdClient,
  SupervisorUnavailableError,
  buildSpill,
  collectSpill,
  formatSpill,
  renderTranscript,
  resolveOcdPaths,
  type Attention,
  type AttentionResponse,
  type MemoryScope,
  type Task,
} from "@ocd/core";
import {
  ConfigError,
  DatabaseTooNewError,
  GhPullRequests,
  LiveConfig,
  LockHeldError,
  loadConfig,
  normalizeDirectory,
  startDaemon,
} from "@ocd/supervisor";

import { checkGh, describeGh, ghServiceHints, miseShim, serviceGh } from "./github.ts";
import { insideWorktree } from "./guard.ts";
import { buildAdapters, buildManagerChannel, probeHarnesses } from "./harnesses.ts";
import {
  FallbackNotifier,
  currentPlatform,
  execCommand,
  extraBinDirs,
  servicePath,
  shellQuote,
  focusManager,
  locateBinary,
  type Platform,
} from "./platform/index.ts";
import { followInterval, followTranscript } from "./peek.ts";
import { addRepo, removeRepo } from "./repo-config.ts";

const HELP = `ocd — local agent control plane

Supervisor
  ocd daemon                        Run the supervisor in the foreground
  ocd service install|status|uninstall
                                    Run the supervisor in the background and at login
                                    (LaunchAgent on macOS, systemd user unit on Linux)
  ocd stop                          Stop the supervisor and report worker outcomes
  ocd restart [--force]             Restart the background service (picks up a new build); refuses while
                                    Claude Code / Codex workers are running unless --force
  ocd status                        Show supervisor status
  ocd pause | ocd resume            Stop / restart new dispatch (running workers continue)
  ocd doctor [--notify]             Check harnesses, the OpenCode service, notifications, the service manager and
                                    the GitHub CLI (gh) as both this shell and the background service would find it;
                                    --notify sends a test notification (click it to try \`ocd focus\`)
  ocd focus                         Switch to the manager session (tmux pane + terminal window); what a notification click runs

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
  ocd task cleanup <id> [--force]   Remove a finished task's worktree and branch (refuses to lose work)

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
Environment: OCD_HOME (default ~/.ocd), OCD_SOCKET
`;

const paths = resolveOcdPaths();
const client = new OcdClient({ socketPath: paths.socket, actor: "human" });
const platform: Platform = currentPlatform();

/** The built CLI, resolved through symlinks so services and click actions survive a relink. */
function cliPath(): string {
  return realpathSync(fileURLToPath(import.meta.url));
}

/**
 * What a notification click runs: `ocd focus` with this process's Node and
 * state directory. Notification daemons start it with a bare environment, so
 * OCD_HOME / OCD_CONFIG are passed explicitly.
 */
function focusCommand(): string[] {
  const env = (["OCD_HOME", "OCD_CONFIG"] as const).flatMap((k) =>
    process.env[k] ? [`${k}=${process.env[k]}`] : [],
  );
  return [...(env.length ? ["/usr/bin/env", ...env] : []), process.execPath, cliPath(), "focus"];
}

/** gh.binary from ocd.jsonc, `~` expanded; null when unset or the file is invalid. */
function configuredGh(): string | null {
  try {
    return new LiveConfig(loadConfig(paths.config)).ghBinary;
  } catch {
    return null;
  }
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
  return `${t.id}  ${t.state.padEnd(16)} ${t.repo.padEnd(14)} ${t.harness.padEnd(8)} ${t.title}`;
}

function attentionLine(a: Attention): string {
  const target = a.taskId ? ` ${a.taskId}` : "";
  return `${a.id}  ${a.status.padEnd(8)} ${a.kind.padEnd(16)}${target}  [${a.resolvableBy}] ${a.reason}`;
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  // Approvals need a person at a terminal, not a script or an agent's shell tool.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt} Type "approve" to confirm: `)).trim() === "approve";
  } finally {
    rl.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
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
      method: { type: "string" },
      draft: { type: "boolean" },
      commit: { type: "boolean" },
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
    },
  });
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
    case "daemon": {
      const background = flags.background ?? false;
      let daemon: Awaited<ReturnType<typeof startDaemon>>;
      try {
        daemon = await startDaemon({
          paths,
          foreground: !background,
          adapters: buildAdapters,
          managerChannel: buildManagerChannel,
          // gh is resolved per call: gh.binary from ocd.jsonc (live), else PATH.
          pullRequests: ({ live }) =>
            new GhPullRequests({ binary: () => live.ghBinary, extraDirs: extraBinDirs() }),
          notifier: await platform.notifier({ onClick: focusCommand() }),
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
            await platform.notifier()
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
      process.exit(0);
      return;
    }
    case "service":
    case "launchagent": {
      const service = platform.service;
      if (!service)
        fail(`no background service manager for ${process.platform}; run \`ocd daemon\` instead`);
      if (sub === "install") {
        const status = await client.status().catch(() => null);
        const current = await service.status();
        if (status && !current.loaded) {
          fail(
            `a supervisor is already running (pid ${status.pid}); stop it with \`ocd stop\` first`,
          );
        }
        const { definition } = await service.install({
          nodePath: process.execPath,
          cliPath: cliPath(),
          logsDir: paths.logs,
          env: { OCD_HOME: process.env["OCD_HOME"], OCD_CONFIG: process.env["OCD_CONFIG"] },
        });
        // The service does not get this shell's PATH; say so if gh would go missing.
        const ghHints = ghServiceHints({
          configured: configuredGh(),
          shellPath: locateBinary("gh"),
          service: serviceGh({
            configured: configuredGh(),
            servicePath: servicePath(process.execPath),
          }),
          shim: miseShim("gh"),
        });
        print({ definition, manager: service.kind, warnings: ghHints }, json, () =>
          [
            `installed ${definition}; the supervisor now runs in the background (${service.kind}) and starts at login`,
            ...(ghHints.length ? ["warning: pull requests will fail:", ...ghHints] : []),
          ].join("\n"),
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
      try {
        const config = loadConfig(paths.config);
        directory = config.manager ? normalizeDirectory(config.manager.directory) : null;
        focusApp = config.notifications.focusApp;
      } catch {
        // An invalid config still lets tmux detection raise the terminal.
      }
      const steps = await focusManager({
        directory,
        tmux: locateBinary("tmux"),
        focusApp,
        exec: execCommand,
        activate: (app) => platform.activate(app),
      });
      print({ steps }, json, () => steps.join("\n"));
      return;
    }
    case "restart": {
      const service = platform.service;
      const before = await client.status().catch(() => null);
      const current = service ? await service.status() : null;
      if (!service || !current?.loaded) {
        fail(
          before
            ? `the supervisor (pid ${before.pid}) is not running as a background service; stop it with Ctrl-C or \`ocd stop\` and start \`ocd daemon\` again, or use \`ocd service install\``
            : "no background service installed; run `ocd daemon` or `ocd service install`",
        );
      }
      // Supervisor-owned processes (Claude Code, Codex) are interrupted by a
      // restart; OpenCode workers live in the OpenCode service and are reattached.
      const interrupted = before
        ? (await client.listTasks({ open: true, limit: 200 })).filter(
            (t) =>
              t.harness !== "opencode" &&
              (t.state === "starting" || t.state === "running" || t.state === "blocked"),
          )
        : [];
      if (interrupted.length && !flags.force) {
        fail(
          [
            "a restart would interrupt these workers (their sessions are kept for `ocd task resume`):",
            ...interrupted.map((t) => `  ${t.id} ${t.harness} ${t.state} ${t.title}`),
            "wait for them, or pass --force",
          ].join("\n"),
        );
      }
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
        ].join("\n"),
      );
      return;
    }
    case "spill": {
      const snapshot = buildSpill(await collectSpill(client));
      print(snapshot, json, () => formatSpill(snapshot));
      return;
    }
    case "pause":
    case "resume": {
      const r = command === "pause" ? await client.pause() : await client.resume();
      print(r, json, () => `dispatch ${r.paused ? "paused" : "resumed"}`);
      return;
    }
    case "doctor": {
      const harnesses = await probeHarnesses();
      const gh = await checkGh({
        configured: configuredGh(),
        extraDirs: extraBinDirs(),
        servicePath: platform.service ? servicePath(process.execPath) : null,
      });
      const notifier = await platform.notifier({ onClick: focusCommand() });
      const tmux = locateBinary("tmux");
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
        harnesses,
        github: gh,
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
        return [
          ...harnesses.map(
            (r) =>
              `${r.harness.padEnd(9)} ${r.available ? "ok" : "--"} ${r.version ?? ""} ${r.problems.join("; ")}`,
          ),
          `${"notify".padEnd(9)} ${notifier.backend}${notifier.clickable ? ", click opens the manager" : ", not clickable"}`,
          ...(delivery ? [`${"".padEnd(9)} test notification ${delivery}`] : []),
          `${"tmux".padEnd(9)} ${tmux ?? "not found (ocd focus can only raise the terminal)"}`,
          `${"service".padEnd(9)} ${platform.service?.kind ?? "none"} (${platform.name})`,
          `${"gh".padEnd(9)} ${describeGh(gh.shell)}`,
          ...(gh.service
            ? [
                `${"".padEnd(9)} background service: ${gh.service.path ?? `not found (${gh.service.problem})`}`,
              ]
            : []),
          ...gh.hints.map((h) => `  ${h}`),
          ...hints,
        ].join("\n");
      });
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
            d.task.error ? `error: ${d.task.error}` : "",
            d.task.result?.reported
              ? `reported: ${d.task.result.reported.summary}`
              : d.task.result?.reportError
                ? `report: ${d.task.result.reportError}`
                : "",
            d.task.result?.verification
              ? `verified changed files: ${d.task.result.verification.changedFiles.join(", ") || "none"}`
              : "",
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
            () => client.peekTask(id, { limit: 50, reasoningSummaries }),
            { intervalMs: interval, signal: stop.signal, json, write: (line) => console.log(line) },
          );
          if (r.end === "errors" || r.end === "unavailable") fail(`stopped following: ${r.detail}`);
          if (!json) console.log(`(stopped following: ${r.detail})`);
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
      } else if (sub === "cleanup") {
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
      } else fail("usage: ocd task list|show|peek|send|cancel|accept|resume|takeover|giveback");
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
          const items = await client.listAttention({ status: "open", limit: 200 });
          const item = items.find((a) => a.id === id);
          if (item?.kind === "permission") {
            console.log(`Permission request from ${item.taskId}: ${item.reason}`);
            console.log(`Operation: ${JSON.stringify(item.operation)}`);
            if (!(await confirmInteractive("Approve this operation?")))
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
