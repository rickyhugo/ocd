# Claude Code and Codex adapters

Both harnesses run as worker processes owned by the supervisor: one process
per task session, started in the task worktree with only the filtered
environment (base variables plus the profile's `envAllowlist`). They use your
normal CLI logins (`~/.claude`, `~/.codex`). Workers die with the supervisor;
`ocd task resume <id> --mode reattach` continues the same session from the
harness's own records.

Both are off by default; turn on the ones you use (then restart the supervisor):

```jsonc
"claude": { "enabled": true },
"codex": { "enabled": true },
```

Profiles:

```jsonc
"cc":    { "harness": "claude", "model": "sonnet#high", "permissionPolicy": "ask" },
"codex": { "harness": "codex",  "model": "gpt-5-codex#medium", "permissionPolicy": "ask" }
```

`#…` is the reasoning effort (`--effort` for Claude Code, `effort` for Codex).

## Worker processes

A worker process stays alive between turns so follow-up instructions reach
the same session. After `workerIdleMinutes` (10) idle it is stopped; the next
instruction to that task resumes the session transparently (`--resume` /
`thread/resume`), and one that arrives while the process is still stopping
waits for it, then resumes. Accepting or cancelling a task stops its process
at once.

A follow-up sent while a turn is running is handled the way each harness
does it. Codex steers the running turn (`turn/steer`); if that turn has just
ended, the text starts a new turn. Claude Code either folds the message into
the running turn or runs it as a turn of its own after the current one; OCD
starts Claude Code with `--replay-user-messages` and treats the worker as
finished only once every message it sent has been picked up, so a steered
worker is not reviewed on its first turn's result. An interrupt followed
straight away by a new prompt is not read as a failure. (Recorded against
Claude Code 2.1.299 and codex 0.162.1.)

Each worker runs in its own process group. A stop that has to be forced
(SIGTERM, then SIGKILL) signals the whole group, so tools the worker started
(dev servers, test watchers) stop with it.

## `yolo`

`"permissionPolicy": "yolo"` starts Claude Code with
`--dangerously-skip-permissions` (the stdio prompt channel stays open for the
few prompts it still raises, which OCD approves) and Codex threads with
`approvalPolicy: "never"`, `sandbox: "danger-full-access"`. Nothing is
recorded per request; there is no sandbox.

## Claude Code (recorded against 2.1.296)

- `claude -p --input-format stream-json --output-format stream-json --verbose
  --session-id <uuid> --model <m> [--effort <e>] --permission-mode default
  --permission-prompt-tool stdio`. The process stays alive between turns; each
  turn ends with one `result` message.
- OCD chooses the session id up front; reattach uses `--resume <id>`.
- Permission prompts arrive as `can_use_tool` control requests and are
  answered per the profile policy (`allow` approves with the original input,
  never "always"). The permission mode is always passed explicitly so
  settings files cannot change it.
- Usage limits (`rate_limit` errors, 429, "usage limit" results) become a
  blocked task, not a failure. Interrupts use the `interrupt` control request.
- `ocd doctor` checks `claude --version` and `claude auth status`.
- Not used: the profile `agent` field (no stable CLI equivalent).

## Codex (recorded against 0.162.1)

- `codex app-server`: newline-delimited JSON-RPC without the `jsonrpc`
  field. OCD sends `initialize`/`initialized`, checks `account/read`, then
  `thread/start` with `approvalPolicy: "on-request"`, `sandbox:
  "workspace-write"`, `approvalsReviewer: "user"`. The thread id is the session
  id; reattach uses `thread/resume`.
- Codex works freely inside the worktree; anything riskier arrives as
  `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`
  and is answered `accept`/`decline` per the profile policy (never
  `acceptForSession`). Other server requests are declined so a worker never
  waits on OCD.
- `turn/completed` with `failed` and `usageLimitExceeded`/`rateLimitExceeded`
  becomes a blocked task. Follow-ups during a turn use `turn/steer`.
- `ocd doctor` checks `codex --version`; login is checked when a session
  starts.

## Transcripts (`ocd task peek`)

Both adapters keep a bounded, in-memory record of what they already receive
(300 entries / ~200 000 characters per session, 32 sessions per adapter,
released sessions evicted first). It is not persisted and is lost on a
supervisor restart; peeking never starts or resumes a process to fill it.

- Claude Code: complete `assistant` messages' `text` and `tool_use` blocks,
  and the `tool_result` blocks of `user` messages, merged into their call by
  `tool_use_id`. Ids are the message `uuid` + block index, or the tool-use id.
  `thinking` / `redacted_thinking` blocks, user text (prompts) and
  `stream_event` partials are dropped. stream-json carries no timestamps, so
  entries are stamped when OCD receives them. No documented reasoning-summary
  field exists, so summaries are `unsupported`.
- Codex: `item/started` and `item/completed` thread items, keyed by item id
  (a completed item replaces its started one in place; timestamps are
  `startedAtMs` / `completedAtMs`): `agentMessage`, `plan`,
  `commandExecution` (command, aggregated output, exit code), `fileChange`
  (paths and kinds, never the diff), `mcpToolCall`, `dynamicToolCall`,
  `webSearch`, `imageView`. `reasoning` items contribute only their `summary`,
  and only on request; `content` (raw reasoning) is never read, and
  `item/reasoning/textDelta` stays opted out. `userMessage` / `hookPrompt`
  items and all deltas are dropped. Shapes are from the 0.162.1 generated
  schema (`codex app-server generate-ts`); no real run has confirmed which
  models populate `summary`.

## Verification status

| Check                                        | Status                                             |
| -------------------------------------------- | -------------------------------------------------- |
| Flags and message shapes match the versions  | From `--help`, generated schemas, SDK              |
| Version and login probes on this machine     | Done (`ocd doctor`)                                |
| Session lifecycle, approvals, limits, resume | Fake binaries in `packages/adapters/test-fixtures` |
| One real task per harness                    | `scripts/smoke.sh` (spends tokens), not yet run    |
| Transcript extraction                        | Fake binaries only; not checked against real runs  |
