# OCD implementation plan

## Goal

Build a small, local-first control plane for personal agentic coding workflows:

1. One global OpenCode manager is the human's conversational point of contact.
2. The manager delegates work to explicitly selected repositories, harnesses,
   agent profiles, and models.
3. Tasks, decisions, and useful memory survive context compaction and restarts.
4. A deterministic supervisor watches execution and notifies the human when
   attention is needed.

Keep Gas Town's delegation idea, not its organizational machinery. The manager's
conversation is an interface, **not the source of truth**.

This is the original plan. Milestones 1–5 are implemented; [Where the plan
moved](#where-the-plan-moved) records what was built beyond it and where its
boundaries now sit. `README.md` has the current status and known gaps.

## First-iteration boundaries

Include a repository registry, named execution profiles, isolated workspaces,
bounded dispatch, a persistent task ledger, explicit memory, an attention inbox,
macOS notifications, and an OpenCode V2 plugin. Support real OpenCode, Claude Code,
and Codex workers through a common adapter interface, delivered incrementally.

Start with serial execution. Make concurrency configurable with a low default
after isolation and recovery tests pass. Do not advertise an adapter capability
until it has been implemented and tested against a recorded harness version.

Exclude web UI, Linear synchronization, vector databases, autonomous merging,
automatic destructive cleanup, recursive worker delegation, continuous LLM
watchdogs, distributed workers, and automatic retries of uncertain coding runs.
Do not install or enable a LaunchAgent or modify global OpenCode configuration
without a separate explicit setup action.

## Architecture

```text
Human <-> OpenCode manager session
                  |
        One OpenCode V2 plugin package
        [control | memory | attention]
                  |
       Local HTTP API over a Unix socket
                  |
         One Node supervisor process
         [dispatch | reconcile | outbox]
                  |
         SQLite via Drizzle ORM
                  |
      +-----------+-----------+
      |           |           |
 OpenCode API  Claude CLI  Codex app-server
      |           |           |
       Per-task repository workspaces
```

The supervisor is the only writer of OCD state. Plugins are thin clients, not
independent schedulers. Workers continue to be owned by the supervisor after the
manager's dispatch tool returns a task ID.

## Technology and package boundaries

| Concern         | Decision                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | Node.js 24; retain the existing mise pin                                                                                   |
| Language        | TypeScript 7.0.2, strict ESM, NodeNext resolution; built-in `tsc` LSP                                                      |
| Toolchain       | Vite+ 1.1.0 and pnpm workspaces; retain existing pins                                                                      |
| Local API       | Fastify over a restrictive Unix-domain socket                                                                              |
| Validation      | Zod at tool, API, configuration, and adapter boundaries                                                                    |
| Persistence     | SQLite + `better-sqlite3` + **Drizzle ORM**, not Kysely                                                                    |
| Migrations      | Drizzle Kit generates checked-in, reviewed SQL migrations                                                                  |
| Logging         | Pino, with secret redaction and bounded log retention                                                                      |
| Tests           | Vitest through `vite-plus/test`, fake adapters, temporary databases                                                        |
| Packaging       | `vp pack`; externalize native drivers and host SDK dependencies                                                            |
| macOS lifecycle | User LaunchAgent running a pinned Node binary and built JS (optionally the self-updated build in `~/.ocd/install/current`) |

Use a compatible, pinned Drizzle ORM/Kit pair when implementation begins. Do not
adopt an RC automatically because current documentation demonstrates one. Apply
reviewed migrations explicitly; never use schema `push` against a live user DB.
Implement FTS5 tables/triggers with custom reviewed migrations where needed.

Introduce these package boundaries as implementation grows:

```text
packages/
  core/        # Zod contracts, task states, profiles, typed API client
  supervisor/  # API, Drizzle schema/migrations, scheduling, recovery, outbox
  adapters/    # OpenCode, Claude Code, Codex, and fake implementations; one descriptor each + the registry
  plugin/      # OpenCode V2 tools, contextual briefing, manager integration
  cli/         # Repository/profile setup, status, attention, lifecycle controls
```

The plugin must not import SQLite or own database migrations. Keep its dependency
graph compatible with the OpenCode host. Do not bundle or replace the host's
plugin SDK. The skeleton's root `src/index.ts` is temporary, not the final daemon.

## Global manager and plugin

Declare the manager explicitly. (Implemented as `manager.directory` in
`ocd.jsonc`: sessions in that directory act as manager, and the most recently
used one receives updates.) A globally configured plugin may load in multiple
locations; this does not create a singleton manager. Route worker results and
attention requests to the active manager session only. A plugin reload must not create another supervisor or
manager, and workers must not receive unrestricted dispatch tools.

Use a dedicated control-plane directory outside any application repository for
the manager. Maintain an allowlisted repository registry with stable names,
canonical paths, and optional default profiles. Resolve real paths and validate
worktree ownership before executing. The model cannot supply arbitrary shell
commands as harness definitions.

Proposed manager tools (names are OCD's API design, not existing OpenCode tools):

- `dispatch_task(repo, profile, instructions, acceptance_criteria)`
- `list_tasks(filters)` and `inspect_task(id)`
- `peek_task(id)`: read-only recent worker messages and tool activity
  (implemented; see README "Peek at a worker")
- `send_to_worker(id, instructions)` and `cancel_task(id)`
- `list_attention()` and `resolve_attention(id, response)`
- `remember(scope, content, source)`, `recall(query, scope)`, and `forget(id)`

On a fresh manager session or after context loss, load a bounded briefing of
active tasks, pending decisions, and applicable confirmed preferences. Retrieve
details on demand. Treat worker output and retrieved agent-authored notes as
untrusted data, not higher-priority system instructions. Register a replacement
manager explicitly if the old session is unavailable.

Manager wake-ups are queued and coalesced. Ordinary progress does not trigger a
model call; completion, blockers, and new requests may. Store pending wake-ups
durably and reconcile delivery against the selected API's actual capabilities.

## Supervisor lifecycle and transport

Provide a foreground mode for development and a separate macOS install command
that creates a user LaunchAgent. Use absolute executable paths: launchd does not
inherit an interactive shell's PATH, so the supervisor reads the login shell's
PATH at startup for the tools it runs. No sudo, shell profile changes, or
browser server is required.

Only one daemon may own the state directory. Acquire an OS-held singleton lock
before accepting requests or dispatching. PID files alone are not sufficient;
check ownership before removing stale sockets. Use a short per-user socket path,
directory permissions `0700`, and socket permissions `0600`. No public listener.
Reject incompatible API versions rather than silently misinterpreting requests.

The process has four responsibilities:

1. Persist and admit work within configured capacity limits.
2. Watch supported harness events and pending interaction requests.
3. Reconcile actual workers against persisted state on startup, periodically,
   after stream reconnection, and after waking from sleep.
4. Deliver persisted attention alerts and manager updates through an outbox.

Pause prevents new dispatch while running workers continue. Cancel requests
interruption of one known task and preserves its workspace. Graceful daemon stop
must explicitly report its worker policy; for CLI-owned workers, interrupt them
and record recoverable session IDs rather than promising they survive loss of
their control pipes. LaunchAgent crash restart does not mean coding runs resume
automatically. Never delete workspaces as a side effect of cancelling a task.

The Mac must be awake for continuous execution. On wake, reconcile; do not count
sleep time as proof that a worker hung.

## Task state and recovery

Proposed task states:

```text
queued -> starting -> running -> ready_for_review -> completed
                       |  ^
                       v  |
                     blocked

Other outcomes: failed, interrupted, cancelled, needs_attention
```

Persist task ID, idempotency key, repository, profile snapshot, harness/model,
instructions, acceptance criteria, workspace/branch, session/thread ID, attempts,
timestamps, process ownership metadata, pending interaction IDs, and result.
Track dependencies separately; only successful dependencies release queued work.

Persist dispatch intent before external side effects. Record identifiers as soon
as adapters acknowledge them. Retry an API submission only when the API supports
the required idempotency or reconciliation proves the original was not admitted.
On daemon restart, look up existing sessions and workspaces before launching any
replacement. PID existence is not proof that a process belongs to OCD.

If a crash leaves an ambiguous launch or a harness cannot reattach to a live
process, mark the task `needs_attention` or `interrupted`. Preserve artifacts and
offer an explicit resume action. Do not silently repeat edits. Promise durable
records and conservative reconciliation, not exactly-once external execution.

Idle, process exit zero, and an agent's claim of success are not sufficient proof
of completion. Collect a structured report: changed files, branch/workspace,
tests and outcomes, unresolved issues, and summary. Distinguish worker-reported
claims from independently run verification. Successful execution becomes
`ready_for_review`; the human explicitly accepts completion. No automatic merge.

## Harness adapters

Define capabilities for start, inspect, steer, interrupt, resume, pending
permissions/questions, structured results, and usage reporting. Unsupported
features must fail clearly. Each profile selects a real harness, its supported
model, instructions/agent preset where supported, and a permission policy.

| Harness     | First integration path                                                 | Important boundary                                                                       |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenCode    | V2 authenticated client and managed service                            | Live events have no replay or automatic reconnection; reconcile state                    |
| Claude Code | CLI print mode with structured JSON streaming and explicit session IDs | Headless permissions need an explicit bridge or deny policy; do not default to bypass    |
| Codex       | App-server JSON-RPC over stdio                                         | Map thread/turn IDs and server approval requests; avoid experimental WebSocket transport |

Everything that differs between harnesses lives in one descriptor next to its
adapter (name, label, config section, how to build and probe it, model rules and
listing, login check) and is listed once in the registry
(`packages/adapters/src/registry.ts`). The supervisor, CLI, `ocd setup`/`doctor`
and the config schema iterate the registry and never name a harness; a test
guards this. OpenCode's other role, hosting the manager (wake-ups, the plugin,
`opencode reload`), sits behind `MANAGER_HOST`. See `docs/adding-a-harness.md`.

Use each installed harness's normal authentication, subject to its vendor terms
and usage limits. Do not copy subscription tokens between products or infer that
an SDK accepts the same authentication as its CLI. Record binary versions and
capability checks; missing binaries/authentication produce actionable errors.

Forward only selected environment variables. Do not inherit unrelated credentials
into worker shells. Passing a task to another harness does not transfer OpenCode
plugins, memory, tools, or permissions automatically.

## Memory and persistence

Execution records and knowledge are separate tables. Proposed entities:
repositories, profiles, tasks, task dependencies, worker runs, task events,
decisions, memories, attention requests, and outbox deliveries.

Knowledge entries include scope (`global`, repository, or task), content, source,
confirmation status, timestamps, and supersession/retirement metadata. Explicit
human preferences can be confirmed immediately; agent-inferred lessons are
proposals until confirmed. Keep retrieval project-scoped by default, with shared
global preferences added deliberately. Support correction and deletion.

Begin with SQLite FTS5 search and bounded snippets, not embeddings or automatic
transcript ingestion. Store references to larger artifacts instead of repeatedly
copying full tool output. Never save secrets as memory. Compaction summaries are
useful context, not replacements for task/decision records.

Use foreign keys, transactions, WAL, and a busy timeout. State transitions and
their outbox entries commit together. Runtime data lives outside the Git repo
under a configurable private per-user data directory. Back up through a
SQLite-aware backup operation; do not copy only a live DB file and omit WAL.
Test restoring backups before claiming recoverability.

## Attention and permissions

Persist requests for decisions, permission prompts, failures, suspected stalls,
and review-ready results. Include task/repo identity, a redacted reason, the exact
pending operation when applicable, and a CLI/session reference. macOS desktop
notifications are the first delivery channel; remote channels are later work.
Delivery failures must remain visible in the inbox and logs.

Use outbox retries and stable deduplication keys. External notifications may be
at-least-once; do not claim exactly-once delivery. Rate-limit repeated stall alerts
without hiding changes to the underlying request.

An approval binds to the originating harness, task, live session/turn, request,
operation, and expiry. Resolve only after explicit human input; the manager cannot
self-approve a request intended for the human. Expired or disconnected requests
must be refreshed/rejected, not replayed against a new worker. Remote replies are
out of scope until authentication and binding are implemented.

Distinguish human workflow decisions from native harness permission checks. If
the first adapter version cannot forward a permission safely, deny it and surface
the block; never substitute `approve-all` by default. (Implemented: a profile may
explicitly opt in to `"permissionPolicy": "allow"`, which approves each request
once and records it, or `"yolo"`, which turns the harness's permission checks
and sandbox off. Neither is ever a default.) Quota limits, permission waits, and
healthy idle sessions are not hangs. Inactivity requests inspection, not killing.

## Workspace and authority boundaries

Create one managed Git worktree per editing task. Parallel tasks never edit the
same checkout. Verify repository/path ownership and refuse collisions. Preserve
dirty worktrees and unpushed commits; explicit cleanup is separate from execution.
(Implemented: an opt-in, deterministic branch-sync watchdog reports drift from a
repo's `baseRef` and, in `refresh` mode, fast-forwards or merges it into clean,
idle task branches at lifecycle boundaries only; see `docs/branch-sync.md`.)

Worktrees isolate edits, not secrets, network access, or arbitrary shell commands.
Use harness sandbox/permission controls and repository branch protection. Require
human authorization for destructive operations, production changes, and merges.
Keep a constrained manager, an allowlist of profiles/repos, and bounded concurrency.
Usage estimates are not hard billing caps; document harness-specific limits.

## Milestones

### 0. Repository preparation (done)

- Remove the browser template and retain pinned Node/pnpm/Vite+ tooling.
- Add strict Node ESM checking and Node packaging configuration.
- Record this plan and wire Neovim to matching local tools.

### 1. Durable core and foreground daemon

- Introduce package boundaries, Zod contracts, Drizzle schema, and migrations.
- Implement the singleton, local API, task transitions, and fake adapter.
- Add CLI status, pause/resume, cancellation, and attention inspection.
- Test crash boundaries and replay before adding real model calls.

### 2. OpenCode vertical slice

- Register repos/profiles and create isolated workspaces.
- Implement native OpenCode workers and the V2 plugin's dispatch/status tools.
- Register the manager and route structured results/pending requests back to it.
- Prove one complete task and safe restart recovery.

### 3. Memory and attention

- Implement scoped remember/recall/correct/forget and cold-start briefings.
- Add the transactional outbox, desktop notifications, and bound human responses.
- Test notification retries, duplicate events, and expired requests.

### 4. Cross-harness execution

- Add Codex app-server and Claude Code CLI adapters incrementally.
- Normalize capabilities, errors, usage limits, results, and interaction requests.
- Test each installed version; unsupported interactions must block safely.

### 5. Opt-in background operation

- Add user LaunchAgent install/status/uninstall with explicit worker-stop semantics.
- Validate sleep/wake, log rotation, DB backup/restore, and low concurrency.
  (Backup and restore are tested. Sleep/wake has not been tried across a real
  sleep; see the README's known gaps. Logs rotate at startup and while running.)
- Keep automatic merging and destructive cleanup out of scope. (Still true; see
  below for what changed around it.)

## Where the plan moved

Built after milestones 1–5. A human still decides what reaches a base branch
and what work is thrown away.

- **Review and landing.** `ocd task diff` (and a diff panel in the TUI) shows a
  task's changes; request changes sends feedback to the same worker session.
  `ocd task land` accepts a task, opens or reuses a pull request, and merges it
  only once GitHub reports it mergeable with every check passed, never with
  admin overrides and only at the commit GitHub checked. The manager has the
  same tool (`ocd_land_task`), told to use it only when the human asks. That
  is an instruction to the model, not a check in the supervisor: the gates the
  supervisor relies on are pull requests being opt-in (`github.enabled`), the
  repository's checks and branch protection. A direct push to the base branch
  is different: the human must type `approve` for the exact commits shown, and
  the manager can only ask for it through the inbox. Merging on request is in
  scope; merging nobody asked for is still out.
- **Cleanup.** Throwing work away (`ocd task discard`, `cleanup --force`) asks
  for a typed `approve`. Opt-in automatic cleanup (`autoCleanup`) removes only
  worktrees of finished tasks whose work is safe elsewhere (landed, or in
  another branch or remote) and never forces, so it is not destructive cleanup.
- **Self-update** (opt-in, `selfUpdate`). OCD follows its own repository and
  installs what reaches its default branch: it builds in a separate worktree,
  boots the build once against a throwaway home, checks that the build loads
  the operator's `ocd.jsonc` (`ocd config check`), switches
  `~/.ocd/install/current` and restarts. It waits while Claude Code or Codex
  workers run unless the human applies it, and keeps the previous build for
  `ocd update rollback`. It installs only commits someone already merged; it
  never merges them.
- **Manual mode, peek and branch sync.** A human can take over a worker session
  and give it back; `ocd task peek` reads recent worker activity without
  touching it; an opt-in watchdog reports drift from the base branch and, in
  `refresh` mode, merges the base into clean, idle task branches (never
  pushing, rebasing or resolving conflicts).
- **Optional tools.** GitHub CLI, tmux, Claude Code and Codex are off until
  turned on in `ocd.jsonc`; only OpenCode and git are required.
- **Notifications** come from OCD's own copy of terminal-notifier, so they carry
  OCD's name and icon, and arrive batched into short digests.

## Next

The current phase is daily use on one Mac. It should answer what is still
unverified.

Not yet verified in real use:

- **Codex:** a full task through OCD. The adapter is checked against real
  codex (turns, steering, interrupts), but no task has run end to end.
- **Sleep:** workers are picked up again after the Mac sleeps, without false
  "stalled" alerts (acceptance test 14).
- **Setup:** `scripts/install.sh` and an interactive `ocd setup` on a machine
  without OCD; Linux (systemd unit, notify-send) has never run.
- **TUI:** the sidebar usage line (`◔`) and the `/limits` dialog, rendered in
  OpenCode.

Possible later work, not committed to:

- Token counts and cost per task.
- Remote notification channels.
- Choosing a profile by usage-limit headroom in the supervisor (today the
  manager reads the usage section of its briefing and profile descriptions).

Design debt, deferred until a feature needs it. The seams are in place:
harnesses (`docs/adding-a-harness.md`), platform (`packages/cli/src/platform`,
guarded by a test), git (`GitRunner`), the API contract (one route table in
core), event and status names, and landing and peek as their own services.

- `store.ts` holds every aggregate; split it into repositories (tasks,
  attention, outbox, memory) over a shared transaction.
- Pull requests assume GitHub (`github` config, `pr_*` codes, GitHub merge
  states); a second forge needs a forge-neutral status and error codes next to
  `PullRequestHost`.
- `tui.tsx` mixes views with workflows (accept and clean up, land, approve);
  move those into testable actions shared with the CLI.
- `ocd.ts` is one command switch and `setup.ts` one long function; a command
  registry and setup steps with `check()` / `apply()`.
- Timers are only partly injectable (raw `setInterval`s, `Date.now()` in a few
  places); one scheduler interface would make timing tests deterministic.
- Domain errors extend the HTTP `ApiError`; give them codes from a shared union
  and map them to HTTP status only in `api.ts`.

## Acceptance tests

1. One manager dispatches tasks to two registered repos without changing its cwd.
2. A profile selects the requested real harness/model; unsupported choices fail.
3. Duplicate dispatch requests do not launch duplicate workers.
4. Manager compaction/new session reconstructs tasks and confirmed decisions.
5. Supervisor crashes before/after launch and before/after ID persistence do not
   silently duplicate edits; ambiguous cases become visible attention requests.
6. Lost event streams reconnect and reconcile current task/permission state.
7. Permission and quota waits are classified correctly, not reported as success.
8. Human replies reach only the matching live request; stale approvals fail.
9. Notification retries survive restart and do not create uncontrolled alert loops.
10. A worker's idle/exit signal alone never marks the task completed.
11. Cancellation preserves edits; daemon shutdown reports what happened to workers.
12. Repo-scoped memory does not leak into unrelated workers or global briefings.
13. Database migrations and backup restoration preserve unfinished work/decisions.
14. Closing the TUI does not stop an installed supervisor; sleeping the Mac is
    handled as a gap in availability, not a task failure.

Use fake harnesses and temporary DB/worktree fixtures for routine tests. Real
harness smoke tests are opt-in, bounded, and never silently spend model tokens
or install global services during ordinary checks.

## Primary references

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 client and service](https://opencode.ai/v2/docs/build/client)
- [OpenCode V2 plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Drizzle SQLite drivers](https://orm.drizzle.team/docs/get-started-sqlite)
- [Vite+ packaging](https://viteplus.dev/guide/pack)

Verify exact APIs against the pinned versions before implementation. Conceptual
tool names and behaviors in this plan are not assertions about shipped features.
