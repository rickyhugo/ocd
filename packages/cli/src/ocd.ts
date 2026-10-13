#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  OcdApiError,
  OcdClient,
  SupervisorUnavailableError,
  resolveOcdPaths,
  type Attention,
  type AttentionResponse,
  type MemoryScope,
  type Task,
} from "@ocd/core";
import {
  LockHeldError,
  PendingMigrationsError,
  SupervisorLock,
  backupDb,
  ensurePrivateDir,
  migrationStatus,
  openDb,
  prepareDatabase,
  restoreDb,
  startDaemon,
} from "@ocd/supervisor";

import { buildAdapters, buildManagerChannel, probeHarnesses } from "./harnesses.ts";

const HELP = `ocd — local agent control plane

Supervisor
  ocd daemon [--migrate]            Run the supervisor in the foreground
  ocd stop                          Stop the supervisor and report worker outcomes
  ocd status                        Show supervisor status
  ocd pause | ocd resume            Stop / restart new dispatch (running workers continue)
  ocd doctor                        Check harness binaries, versions and the OpenCode service

Configuration (human only)
  ocd repo add <name> <path> [--profile P] [--base REF] [--verify "cmd arg..."]
  ocd repo list | ocd repo remove <name>
  ocd profile add <name> --harness opencode|fake --model provider/model
                  [--agent A] [--permission deny|ask] [--instructions TEXT] [--env VAR,VAR]
  ocd profile list
  ocd manager register <session-id> [--directory DIR] [--replace]
  ocd manager show

Tasks
  ocd dispatch <repo> <title> --instructions TEXT [--profile P] [--criteria TEXT]... [--key KEY]
  ocd task list [--all] [--repo R]
  ocd task show <id>
  ocd task send <id> <instructions>
  ocd task cancel <id> [--reason TEXT]
  ocd task accept <id>
  ocd task resume <id> --mode reattach|relaunch

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
  ocd db status | ocd db migrate | ocd db backup [path] | ocd db restore <path>

Global flags: --json  (machine-readable output)
Environment: OCD_HOME (default ~/.ocd), OCD_SOCKET
`;

const paths = resolveOcdPaths();
const client = new OcdClient({ socketPath: paths.socket, actor: "human" });

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
      migrate: { type: "boolean" },
      profile: { type: "string" },
      base: { type: "string" },
      verify: { type: "string" },
      harness: { type: "string" },
      model: { type: "string" },
      agent: { type: "string" },
      permission: { type: "string" },
      instructions: { type: "string" },
      env: { type: "string" },
      criteria: { type: "string", multiple: true },
      key: { type: "string" },
      all: { type: "boolean" },
      repo: { type: "string" },
      task: { type: "string" },
      reason: { type: "string" },
      mode: { type: "string" },
      approve: { type: "boolean" },
      deny: { type: "boolean" },
      message: { type: "string" },
      answer: { type: "string" },
      ack: { type: "boolean" },
      proposed: { type: "boolean" },
      supersedes: { type: "string" },
      status: { type: "string" },
      rationale: { type: "string" },
      directory: { type: "string" },
      replace: { type: "boolean" },
    },
  });
  const json = flags.json ?? false;
  const [command, sub, ...rest] = positionals;
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "daemon": {
      const daemon = await startDaemon({
        paths,
        foreground: true,
        migrate: flags.migrate ?? false,
        adapters: buildAdapters,
        managerChannel: buildManagerChannel,
      });
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
          `manager: ${s.manager ? `${s.manager.sessionId} (${s.manager.directory})` : "not registered"}`,
          ...s.adapters.map(
            (a) =>
              `harness ${a.harness}: ${a.available ? `ok ${a.version ?? ""}` : `UNAVAILABLE ${a.problems.join("; ")}`}`,
          ),
        ].join("\n"),
      );
      return;
    }
    case "pause":
    case "resume": {
      const r = command === "pause" ? await client.pause() : await client.resume();
      print(r, json, () => `dispatch ${r.paused ? "paused" : "resumed"}`);
      return;
    }
    case "doctor": {
      const results = await probeHarnesses();
      print(results, json, () =>
        results
          .map(
            (r) =>
              `${r.harness.padEnd(9)} ${r.available ? "ok" : "--"} ${r.version ?? ""} ${r.problems.join("; ")}`,
          )
          .join("\n"),
      );
      return;
    }
    case "repo": {
      if (sub === "add") {
        const [name, path] = rest;
        if (!name || !path) fail("usage: ocd repo add <name> <path>");
        const repo = await client.addRepo({
          name,
          path: resolve(path),
          ...(flags.profile ? { defaultProfile: flags.profile } : {}),
          ...(flags.base ? { baseRef: flags.base } : {}),
          ...(flags.verify ? { verifyCommand: flags.verify.split(" ").filter(Boolean) } : {}),
        });
        print(repo, json, () => `registered ${repo.name} -> ${repo.path}`);
      } else if (sub === "list") {
        const repos = await client.listRepos();
        print(
          repos,
          json,
          () =>
            repos
              .map((r) => `${r.name.padEnd(16)} ${r.path}  profile=${r.defaultProfile ?? "-"}`)
              .join("\n") || "no repositories",
        );
      } else if (sub === "remove") {
        if (!rest[0]) fail("usage: ocd repo remove <name>");
        print(await client.removeRepo(rest[0]), json, () => `removed ${rest[0]}`);
      } else fail("usage: ocd repo add|list|remove");
      return;
    }
    case "profile": {
      if (sub === "add") {
        const name = rest[0];
        if (!name || !flags.harness || !flags.model)
          fail("usage: ocd profile add <name> --harness H --model M");
        const profile = await client.addProfile({
          name,
          harness: flags.harness as "opencode",
          model: flags.model,
          ...(flags.agent ? { agent: flags.agent } : {}),
          ...(flags.instructions ? { instructions: flags.instructions } : {}),
          permissionPolicy: (flags.permission ?? "deny") as "deny" | "ask",
          envAllowlist: flags.env ? flags.env.split(",").filter(Boolean) : [],
        });
        print(
          profile,
          json,
          () =>
            `profile ${profile.name}: ${profile.harness} ${profile.model} permissions=${profile.permissionPolicy}`,
        );
      } else if (sub === "list") {
        const profiles = await client.listProfiles();
        print(
          profiles,
          json,
          () =>
            profiles
              .map(
                (p) =>
                  `${p.name.padEnd(16)} ${p.harness.padEnd(9)} ${p.model}  agent=${p.agent ?? "-"} permissions=${p.permissionPolicy}`,
              )
              .join("\n") || "no profiles",
        );
      } else fail("usage: ocd profile add|list");
      return;
    }
    case "manager": {
      if (sub === "register") {
        if (!rest[0]) fail("usage: ocd manager register <session-id>");
        const m = await client.registerManager({
          sessionId: rest[0],
          directory: resolve(flags.directory ?? process.cwd()),
          replace: flags.replace ?? false,
        });
        print(m, json, () => `manager ${m.sessionId} registered`);
      } else {
        const m = await client.getManager();
        print(m, json, () =>
          m
            ? `${m.sessionId} (${m.directory}) registered ${m.registeredAt} by ${m.registeredBy}`
            : "no manager registered",
        );
      }
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
      } else if (sub === "send") {
        const text = rest.slice(1).join(" ");
        if (!text) fail("usage: ocd task send <id> <instructions>");
        print(await client.sendToWorker(id, text), json, () => `sent to ${id}`);
      } else if (sub === "cancel") {
        const t = await client.cancelTask(id, flags.reason);
        print(t, json, () => `cancelled ${id}; workspace preserved at ${t.workspacePath ?? "-"}`);
      } else if (sub === "accept") {
        print(await client.acceptTask(id), json, () => `accepted ${id} as completed`);
      } else if (sub === "resume") {
        if (flags.mode !== "reattach" && flags.mode !== "relaunch")
          fail("--mode reattach|relaunch is required");
        print(await client.resumeTask(id, flags.mode), json, () => `resumed ${id} (${flags.mode})`);
      } else fail("usage: ocd task list|show|send|cancel|accept|resume");
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
    case "db":
      await dbCommand(sub, rest, json);
      return;
    default:
      fail(`unknown command ${command}\n\n${HELP}`);
  }
}

async function dbCommand(sub: string | undefined, rest: string[], json: boolean): Promise<void> {
  ensurePrivateDir(paths.home);
  ensurePrivateDir(paths.runDir);
  if (sub === "backup") {
    // Online backup is safe while the daemon runs; it only reads.
    if (!existsSync(paths.db)) fail(`no database at ${paths.db}`);
    const target = resolve(
      rest[0] ?? join(paths.backups, `ocd-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.db`),
    );
    const db = openDb(paths.db, { readonly: true });
    try {
      await backupDb(db, target);
    } finally {
      db.$client.close();
    }
    print({ backup: target }, json, () => `backed up to ${target}`);
    return;
  }
  if (sub === "status") {
    if (!existsSync(paths.db))
      return print({ exists: false }, json, () => `no database yet at ${paths.db}`);
    const db = openDb(paths.db, { readonly: true });
    const status = migrationStatus(db);
    db.$client.close();
    print(
      status,
      json,
      () =>
        `${paths.db}: ${status.applied}/${status.available} migrations applied, ${status.pending} pending`,
    );
    return;
  }
  // Writers must hold the supervisor lock, so the daemon has to be stopped.
  const lock = SupervisorLock.acquire(paths.lock, {
    pid: process.pid,
    instanceId: `cli-${sub ?? "db"}`,
  });
  try {
    if (sub === "migrate") {
      ensurePrivateDir(paths.backups);
      const db = await prepareDatabase(paths, { migrate: true });
      const status = migrationStatus(db);
      db.$client.close();
      print(status, json, () => `migrated: ${status.applied}/${status.available} applied`);
    } else if (sub === "restore") {
      if (!rest[0]) fail("usage: ocd db restore <backup>");
      const r = restoreDb(paths.db, resolve(rest[0]));
      print(
        r,
        json,
        () => `restored from ${rest[0]}; previous database kept at ${r.previous ?? "(none)"}`,
      );
    } else {
      fail("usage: ocd db status|migrate|backup|restore");
    }
  } finally {
    lock.release();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof SupervisorUnavailableError ||
    error instanceof LockHeldError ||
    error instanceof PendingMigrationsError
  ) {
    fail(error.message);
  }
  if (error instanceof OcdApiError) fail(`${error.message} (${error.code})`);
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
