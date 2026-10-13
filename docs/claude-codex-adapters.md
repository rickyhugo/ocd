# Claude Code and Codex adapters

Both harnesses run as worker processes owned by the supervisor: one process
per task session, started in the task worktree with only the filtered
environment (base variables plus the profile's `envAllowlist`). They use your
normal CLI logins (`~/.claude`, `~/.codex`). Workers die with the supervisor;
`ocd task resume <id> --mode reattach` continues the same session from the
harness's own records.

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
`thread/resume`). Accepting or cancelling a task stops its process at once.

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

## Verification status

| Check                                        | Status                                             |
| -------------------------------------------- | -------------------------------------------------- |
| Flags and message shapes match the versions  | From `--help`, generated schemas, SDK              |
| Version and login probes on this machine     | Done (`ocd doctor`)                                |
| Session lifecycle, approvals, limits, resume | Fake binaries in `packages/adapters/test-fixtures` |
| One real task per harness                    | `scripts/smoke.sh` (spends tokens), not yet run    |
