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
| 5. Background service           | Implemented: `ocd service install` (launchd / systemd), automatic backups       |

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
  cli/         The `ocd` command and the platform layer (notifications, focus, launchd/systemd)
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
ocd spill                                    # what is running, waiting and ready for review
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
ocd service install     # starts at login, survives closing the terminal
ocd service status
ocd service uninstall
ocd restart             # restart the service, e.g. after `pnpm run build`
```

macOS gets a user LaunchAgent (`~/Library/LaunchAgents/dev.ocd.supervisor.plist`),
Linux a systemd user unit (`~/.config/systemd/user/ocd-supervisor.service`).
Either runs `ocd daemon --background` with absolute paths to the Node binary
and CLI that installed it (service managers do not use your shell's PATH or
mise), and restarts it after a crash, not after `ocd stop`. If it cannot
start (another daemon running, pending migration, invalid config) it sends a
notification and exits instead of restarting in a loop. Logs: `~/.ocd/logs`.
`ocd restart` refuses while Claude Code or Codex workers are running (they
are processes of the supervisor and would be interrupted) unless you pass
`--force`; OpenCode workers survive it. A restart never resumes coding runs automatically; OpenCode workers are
reattached and anything uncertain shows up in `ocd attention list`.

Because the service PATH is fixed when it is installed (the pinned Node's
directory, `~/.local/bin`, Homebrew's and the system directories), tools that
your shell finds through mise activation, asdf or a profile script are not on
it. Re-run `ocd service install` after moving Node or the build; it rewrites
the definition with the current paths. Like `ocd restart`, it restarts the
supervisor, so wait until no Claude Code or Codex worker is running.

### GitHub CLI (pull requests)

`ocd task pr` / `ocd task merge` (and the manager's PR tools) run `gh` with
your own `gh auth` login. The supervisor finds it with:

1. `gh.binary` in `ocd.jsonc`, when set: an absolute path (or `~/…`) to the
   executable. It is used as written; a wrong path is reported, never silently
   replaced by a PATH lookup. Saved changes apply without a restart.
2. Otherwise the first executable `gh` on the supervisor's own PATH, then
   `~/.local/bin` and Homebrew's directories.

```jsonc
// e.g. the output of `command -v gh` or `mise which gh` in your shell.
// With mise, its shim (~/.local/share/mise/shims/gh) keeps working after gh upgrades.
"gh": { "binary": "/opt/homebrew/bin/gh" }
```

`ocd doctor` shows where your shell finds gh, whether the background service
would find it, and whether gh is logged in; it prints the exact `gh.binary`
line to add when the two differ (`ocd service install` warns about it too).
At startup the supervisor runs the same read-only check (`gh --version`,
`gh auth status`, each bounded by a timeout, never a login prompt) in the
background and logs it; `ocd status` shows the result. Startup never waits for
it and a failed check is not fatal.

PR actions fail with a code that says what to fix: `gh_not_found` (set
`gh.binary` or put gh on the service PATH), `gh_invalid_path` (fix
`gh.binary`), `gh_auth_required` (run `gh auth login` / `gh auth refresh` in a
terminal), `gh_unreachable` (network, proxy or GitHub outage, or gh timed out;
the login may be fine, so retry later) and `gh_failed` (anything else, with
gh's message). gh output is redacted before it reaches errors, events or logs.
Each failure is recorded on the task as a `pull_request.failed` event (with
whether the branch was already pushed). Retrying is safe: before creating a
PR, OCD looks for an open PR from the task branch and reuses it.

### Notifications

OCD notifies you when a task is ready for review or needs you. Clicking a
notification runs `ocd focus`, which switches tmux to the pane running OpenCode
in the manager directory and raises the terminal window. `ocd doctor` shows
which backend is in use.

The title says what happened or what is needed; the body names the task by its
title, then the repo and one short fact. Clicking only opens the manager:
permissions are still approved there, never by the notification.

```text
OCD: Review ready              OCD: Permission needed
Fix login redirect loop        Fix login redirect loop
app · 3 files changed          app · Bash: git push origin main
```

Notifications raised within a few seconds of each other arrive as one digest,
such as "OCD: 4 ready for review, 1 needs you", naming each task; a lone
notification is sent as is. Each task counts once, as its latest notification.
The window opens with the first notification and lasts
`notifications.digestWindowMs` (3000 by default; 0 sends on the next outbox
pass). Only desktop notifications wait: task states, inbox items and manager
wake-ups are immediate, and stopping the daemon sends anything still held.
Clicking a digest runs `ocd focus` like any other notification, and
`ocd attention list` shows the items behind it.

| Platform | Backend                                                | Click opens the manager                             |
| -------- | ------------------------------------------------------ | --------------------------------------------------- |
| macOS    | `terminal-notifier` (`brew install terminal-notifier`) | yes                                                 |
| macOS    | `osascript` fallback                                   | no (macOS opens Script Editor)                      |
| Linux    | `notify-send` (libnotify 0.7.9+)                       | yes; the window is raised on Hyprland, sway and X11 |

terminal-notifier needs macOS notification permission (System Settings →
Notifications). Until it has it, OCD falls back to osascript so nothing is
lost, and it tries terminal-notifier again each time. `ocd doctor --notify`
sends a test notification and says which path delivered it.

The terminal is detected from the tmux client (Ghostty, kitty, WezTerm,
Alacritty, iTerm2, Terminal, …); set `notifications.focusApp` to a macOS bundle
id or Linux window class to override it. GNOME and KDE on Wayland do not let
other programs raise windows, so there `ocd focus` only switches tmux. Under
systemd, run `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY
SWAYSOCK HYPRLAND_INSTANCE_SIGNATURE` (most desktops already do) so the
service can reach the desktop.

The platform layer (`packages/cli/src/platform`) is the only place that knows
about the OS: notifier, window activation and service manager sit behind one
`Platform` interface with macOS and Linux implementations.

The daemon also writes an online backup to `~/.ocd/backups/auto-*.db` every
`backups.intervalHours` (24) and keeps the newest `backups.keep` (7).

### In the OpenCode TUI

The plugin's TUI part (`packages/plugin/tui.tsx`, loaded by OpenCode from the
plugin directory) adds:

- **Sidebar:** one line, `▸ OCD  ! 1  ✓ 2  ✗ 1  ● 3`: what needs you, what
  is ready for review, what is stuck, and what is running. Items blocked on you
  (permissions, questions, decisions) are always listed below it. Click the
  line to expand Needs you / Review / Stuck / Running / Queued / Done today;
  each section opens and closes on its own and the choice is remembered. With
  nothing open it reads `OCD  idle · 2 done today` and lists what finished, and
  `kept` marks a finished task whose worktree is still on disk. When the
  supervisor is down it says `offline`. Rows show ages, and running tasks with no
  activity for 10 minutes show as quiet (`○`).
- **Row actions** (click a row) fit the task's state:
  - Ready for review: **Accept and clean up**, **Accept (keep the worktree)**,
    Summarize the result, Accept and open a PR.
  - Finished with a kept worktree: **Clean up the worktree**.
  - Running: Status update, Cancel it. Failed: What happened?, Retry it.
  - Always: a free-form message to the manager, and Details.

  Bold actions call OCD directly as you. Cleanup never forces: a worktree with
  uncommitted changes, or commits that exist on no other branch, is kept and
  the toast says how to proceed (open a PR, or `ocd task cleanup <id>
  --force`). The other actions are messages to the manager, which acts on them
  as your explicit instruction.

- **`/task`:** reference a task when talking to the manager. `/task` opens a
  searchable picker, then asks for your message; `/task <id or words> <message>`
  skips the picker when it matches one task. The manager receives "Regarding OCD
  task t_… (title, repo, state): your message". OpenCode has no plugin API for
  custom `@` mentions, so this is a slash command.

- **`/spill`:** a read-only summary of all open work, read from the
  supervisor when you ask (the same as `ocd spill` in a terminal). It starts
  with counts (`OCD · 3 running · 1 blocked/waiting · 2 ready for review`),
  then lists every open task once under Running, Blocked / waiting, Manual
  (you), Stuck, Queued / starting and Ready for review, plus attention not tied
  to a task. Each entry is the title, then repo, state and age, last activity
  (or `quiet` after 10 minutes), the latest supervisor milestone (`latest:
  follow-up sent 8m ago`), what a blocked task waits on and for whom, and the
  task id for `/task` or `ocd task show`. Completed and cancelled tasks are
  left out. It only reports what OCD recorded: no model summary, transcript or
  worker-written report text, and nothing is sent to the manager or workers.
  The TUI shows up to 8 entries per section and says how many more `ocd spill`
  lists; `ocd spill --json` gives the structured snapshot.

### Manual mode: drive a worker yourself

Take over a worker's session when you want to steer it directly, then give it
back to the manager.

- **Take over**: `/takeover` in the TUI, the row action _Take over (manual
  mode)_, or `ocd task takeover <id>`. OCD interrupts a running turn, stops a
  Claude Code / Codex worker process, expires its pending requests, moves the
  task to `manual` and tells the manager to leave it alone. The session opens
  in a tmux window named `ocd-<id>` in the task's worktree when the TUI runs in
  tmux (it keeps running after you close the terminal; open it again from the
  sidebar), otherwise you get the command: `claude --resume <id>`,
  `codex resume <id>` or `opencode --session <id>`.
- **While manual**: the sidebar lists it under Manual (`◆ you · 12m`); OCD does
  not stall-check it, collect reports or recover it, and the manager cannot
  cancel or resume it.
- **Give back**: `/giveback`, the row actions, or `ocd task giveback <id>
  --mode continue|review [--message NOTE]`. _Continue_ resumes the worker
  headless on the same session with your note and it reports as usual;
  _ready for review_ moves the task to review. The manager is told either way.
  For Claude Code and Codex, give back refuses while the session is still open
  in another process (quit the interactive harness first), so two processes
  never drive one session.

## How work flows

1. The manager calls `ocd_dispatch_task`. The supervisor persists the task and
   returns its ID; the worker is owned by the supervisor from then on.
2. Each task gets its own worktree under `~/.ocd/workspaces/<repo>/<task>` on
   branch `ocd/<task>`. Workspaces are never deleted by OCD.
3. Permission requests block the task and notify you; only a human can approve
   them, from an interactive terminal: `ocd attention resolve <id> --approve`.
   Other `permissionPolicy` values: `deny` (the default) rejects requests and
   records the block; `allow` approves each request once, automatically, and
   records it; `yolo` tells the harness to skip permission checks and its
   sandbox entirely (Claude Code `--dangerously-skip-permissions`, Codex
   `approvalPolicy: never` + `danger-full-access`, an OpenCode allow-all rule),
   so nothing is asked or recorded.
4. When the worker goes idle, OCD collects its `ocd-report` and independently
   checks the worktree with git (changed files, commits, uncommitted changes).
   A valid report makes the task `ready_for_review`.
5. Workers commit to `ocd/<task>` (never push). You accept with
   `ocd task accept <id>`, or tell the manager to accept it (`ocd_accept_task`).
   Nothing is merged automatically.
6. Optionally, `ocd task pr <id> [--draft] [--commit]` (or `ocd_open_pull_request`)
   pushes the branch and opens a GitHub pull request with `gh`; you merge it.
7. `ocd task merge <id> [--method squash|merge|rebase]` (or
   `ocd_merge_pull_request`) merges an accepted task's PR once GitHub reports it
   open, not a draft, conflict-free, unblocked, and with all checks passed; it
   never uses admin overrides. The method defaults to `squash` (per repo:
   `"mergeMethod"`). Afterwards the worktree and both branches are removed.
8. `ocd task cleanup <id>` (or `ocd_cleanup_task`) removes a finished task's
   worktree and branch. It refuses while that would lose work (uncommitted
   changes, or commits on no other branch or remote) unless you pass `--force`.

Crashes, restarts, lost event streams and sleep are reconciled conservatively:
uncertain launches become `needs_attention` instead of being retried, and
interrupted workers are resumed only with `ocd task resume <id> --mode
reattach|relaunch`.

## Security model and limits

The socket is `0600` in a `0700` directory, so other users cannot reach it.
Within your account, three layers keep workers away from the live OCD:

1. **Authenticated API.** Every request must carry the API token in
   `~/.ocd/run/api.token` (`0600`, created once, kept across restarts). The
   `ocd` CLI, the TUI and the manager plugin read it; anything else gets `401`.
   The `human`/`manager` actor header only distinguishes trusted clients; it no
   longer grants anything by itself.
2. **Sandboxed worker environment.** Every worker's shells get `OCD_HOME`,
   `OCD_SOCKET` and `OCD_CONFIG` pointing at a per-task sandbox
   (`~/.ocd/sandbox/<task>`): through the process environment for Claude Code
   and Codex, and through OpenCode's per-session environment for OpenCode
   (a session is never started without it). A worker running `ocd` therefore
   finds no supervisor and no token; `ocd daemon` there starts an isolated one,
   which is how a worker developing OCD can try its changes. Sessions you take
   over in manual mode open with the same environment.
3. **Worktree guard.** `ocd` refuses to talk to the live supervisor from inside
   `~/.ocd/workspaces` unless `OCD_HOME` is set explicitly.

The remaining limit is the OS user: a process running as you can still read
`~/.ocd/run/api.token` on purpose. The layers stop accidents and casual misuse
(a worker testing OCD, a confused or prompt-injected model running `ocd`),
not a deliberately malicious process; only a separate OS user or a harness
sandbox that denies reading `~/.ocd` does that. Keep worker profiles on `ask`
or `deny` unless you opted into `allow` or `yolo`. The human-only checks still
stop the manager _model_ from approving permissions, accepting work or
reconfiguring OCD through its tools, and approving a permission from the CLI
requires typing `approve` in an interactive terminal.

## Memory

`ocd_remember` / `ocd memory add` store scoped (`global`, `repo`, `task`) notes
with FTS5 search. Human statements are confirmed immediately; inferred lessons
are proposals until `ocd memory confirm`. Workers see confirmed memory for
their own repository only; the manager briefing includes confirmed global
preferences, open tasks, pending attention and recent decisions. Secrets are
refused.

## Maintenance

The database migrates itself: on startup the daemon backs up an existing
database to `~/.ocd/backups/pre-migrate-*.db` and applies pending reviewed
migrations in one transaction (a failure leaves the database unchanged). It
refuses to start on a database written by a newer OCD. Automatic backups
(`auto-*.db`) are taken daily.

To restore a backup, stop the daemon (`ocd stop`), move `~/.ocd/ocd.db` and any
`ocd.db-wal` / `ocd.db-shm` aside, copy the backup to `~/.ocd/ocd.db`, and start
the daemon again.

```sh
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
