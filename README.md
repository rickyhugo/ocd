# OCD

A local agent control plane: one OpenCode manager session delegates coding work
to isolated workers, a deterministic supervisor owns durable task, decision and
memory state, and you get notified when something needs a human.

See [PLAN.md](PLAN.md) for the architecture, safety boundaries and milestones.

## Status

| Milestone                       | State                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| 1. Durable core and daemon      | Implemented and tested with fake harnesses                                      |
| 2. OpenCode vertical slice      | Implemented; first real task completed end to end (OpenCode 2.0.28)             |
| 3. Memory and attention         | Implemented and tested                                                          |
| 4. Claude Code / Codex adapters | Implemented; tested with fake binaries ([notes](docs/claude-codex-adapters.md)) |
| 5. LaunchAgent background mode  | Implemented: `ocd launchagent install`, automatic backups                       |

No real model call has been made by the test suite. The only checks against the
real OpenCode service are read-only (`ocd doctor`). See
[docs/opencode-adapter.md](docs/opencode-adapter.md) for exactly what is verified.

## Packages

```text
packages/
  core/        Zod contracts, task states, redaction, report protocol, socket API client
  supervisor/  Fastify API on a Unix socket, Drizzle schema + migrations, scheduler, recovery, outbox
  adapters/    OpenCode, Claude Code, Codex and fake adapters (+ test doubles)
  plugin/      OpenCode V2 plugin: ocd_* manager tools and the manager briefing (no database)
  cli/         The `ocd` command
```

## Setup

With the pinned mise tools installed:

```sh
mise exec -- pnpm install
mise exec -- pnpm run build      # vp pack for every package
mise exec -- pnpm run check      # format, lint, type-check
mise exec -- pnpm test           # fake harnesses and temporary DBs/worktrees only
```

Put `packages/cli/dist/ocd.mjs` on your PATH (for example
`alias ocd="node $PWD/packages/cli/dist/ocd.mjs"`). State lives in `~/.ocd`
(override with `OCD_HOME`).

### Configuration: `ocd.jsonc`

Settings and execution profiles live in one JSONC file, read from `$OCD_CONFIG`
or `~/.ocd/ocd.jsonc` (a symlink into a git repo works well). A profile is a
named recipe for running a worker; repos are the repositories the manager may
dispatch to. Both are referred to by name.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/rickyhugo/ocd/main/schema/ocd.schema.json",
  "concurrency": 1,
  "manager": { "directory": "~/ocd-manager" },
  "repos": {
    "myapp": { "path": "~/code/myapp", "profile": "oc" },
  },
  "profiles": {
    "oc": {
      "harness": "opencode",
      "model": "anthropic/claude-sonnet-4-5",
      "permissionPolicy": "ask",
      "description": "Default for real coding work",
    },
    "oc-cheap": {
      "harness": "opencode",
      "model": "<small model>",
      "permissionPolicy": "ask",
      "description": "Trivial chores: renames, docs, formatting",
    },
  },
}
```

The daemon validates the file at startup and refuses typos, invalid profiles,
and repo paths that are not git repository roots. While it runs, saved changes
to profiles, repos and the manager directory apply immediately (other settings
need a restart); if a save leaves the file invalid, the last good configuration
stays in effect and one item appears in `ocd attention list` until the
file is fixed. [`schema/ocd.schema.json`](schema/ocd.schema.json) gives editors
completion and hover docs; it is generated from the daemon's own validation
(`pnpm run schema`), and a test fails if it drifts. Tasks keep a snapshot of
the profile they were dispatched with; a repo removed from the file stops
accepting new work but keeps its task history.

```sh
ocd daemon                                   # foreground supervisor (Ctrl-C reports worker outcomes)
ocd profile list                             # profiles from ocd.jsonc
ocd repo list                                # repos from ocd.jsonc
ocd status
```

The supervisor needs the OpenCode background service (`opencode service start`).
It discovers it and never starts it itself.

### Manager session

The manager is whichever OpenCode session runs in the directory configured in
`ocd.jsonc`:

```jsonc
"manager": { "directory": "~/ocd-manager" }
```

Sessions started there may use the `ocd_*` tools and get the briefing; the one
used most recently receives supervisor updates. Sessions anywhere else, and
worker sessions, are refused. There is no registration step: a fresh session in
that directory simply takes over. `ocd manager` shows the configured directory
and the active session.

Nothing installs the plugin for you. Load it only in that directory with a
project-level OpenCode config:

```jsonc
// ~/ocd-manager/.opencode/opencode.jsonc
{ "plugins": ["/absolute/path/to/ocd/packages/plugin"] }
```

OpenCode requires a plugin directory (not a file) and loads its `server.js`,
which re-exports the build, so run `pnpm run build` first. After changing the
plugin config, run `opencode reload` (it reloads every OpenCode location).

### Background operation (optional)

```sh
ocd launchagent install     # user LaunchAgent: starts at login, survives closing the terminal
ocd launchagent status
ocd launchagent uninstall
```

The agent runs `ocd daemon --background` with absolute paths to the Node
binary and CLI that installed it (launchd does not use your shell's PATH or
mise). launchd restarts it after a crash, not after `ocd stop`. If it cannot
start (another daemon running, pending migration, invalid config) it sends a
notification and exits instead of restarting in a loop. Logs: `~/.ocd/logs`.
A restart never resumes coding runs automatically; OpenCode workers are
reattached and anything uncertain shows up in `ocd attention list`.

The daemon also writes an online backup to `~/.ocd/backups/auto-*.db` every
`backups.intervalHours` (24) and keeps the newest `backups.keep` (7).

## How work flows

1. The manager calls `ocd_dispatch_task`. The supervisor persists the task and
   returns its ID; the worker is owned by the supervisor from then on.
2. Each task gets its own worktree under `~/.ocd/workspaces/<repo>/<task>` on
   branch `ocd/<task>`. Workspaces are never deleted by OCD.
3. Permission requests block the task and notify you; only a human can approve
   them, from an interactive terminal: `ocd attention resolve <id> --approve`.
   Profiles with `"permissionPolicy": "deny"` reject them and record the block
   instead; `"allow"` approves each request once, automatically, and records it
   (`ocd attention list --all`). The default is `deny`.
4. When the worker goes idle, OCD collects its `ocd-report` and independently
   checks the worktree with git (changed files, commits, uncommitted changes).
   A valid report makes the task `ready_for_review`.
5. You accept with `ocd task accept <id>`, or tell the manager to accept it
   (`ocd_accept_task`). Nothing is merged automatically.

Crashes, restarts, lost event streams and sleep are reconciled conservatively:
uncertain launches become `needs_attention` instead of being retried, and
interrupted workers are resumed only with `ocd task resume <id> --mode
reattach|relaunch`.

## Security model and limits

The socket is `0600` in a `0700` directory, so other users cannot reach it.
Within your user account, the caller's role (`human` or `manager`) is a
request header: the human-only checks stop the manager _model_ from approving
permissions, accepting work, or reconfiguring OCD through its tools, but they
are not authentication. A worker or any process running as you with shell
access could call the socket (or run `ocd`) directly. Keep worker profiles on
`ask` or `deny` unless you opted into `allow`, rely on the harness's own sandbox and permission
rules for shell access, and treat OCD as a coordination layer, not a security
boundary. Approving a permission from the CLI additionally requires typing
`approve` in an interactive terminal.

## Memory

`ocd_remember` / `ocd memory add` store scoped (`global`, `repo`, `task`) notes
with FTS5 search. Human statements are confirmed immediately; inferred lessons
are proposals until `ocd memory confirm`. Workers see confirmed memory for
their own repository only; the manager briefing includes confirmed global
preferences, open tasks, pending attention and recent decisions. Secrets are
refused.

## Maintenance

```sh
ocd db backup                 # SQLite online backup into ~/.ocd/backups
ocd db restore <file>         # daemon stopped; the old DB is kept, not deleted
ocd db migrate                # applies reviewed migrations after a backup
ocd outbox --status dead      # notifications that gave up (also listed in `ocd attention`)
```

Migrations are generated with `pnpm run db:generate` and checked in under
`packages/supervisor/drizzle/`; review the SQL before committing.

## Real smoke test (opt-in, spends tokens)

```sh
scripts/smoke.sh --yes-spend-tokens opencode provider/model
scripts/smoke.sh --yes-spend-tokens claude sonnet
scripts/smoke.sh --yes-spend-tokens codex gpt-5-codex#low
```

It uses a throwaway `OCD_HOME` and git repo, dispatches one tiny task to the
running OpenCode service and prints the result.

## Neovim

`.nvim-tools.lua` configures the `project-tools` plugin with the repo-local
TypeScript 7 `tsc` language server, oxlint as an LSP, and oxfmt formatting.
