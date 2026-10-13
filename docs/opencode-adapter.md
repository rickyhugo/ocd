# OpenCode V2 adapter notes

Recorded against **opencode 2.0.27** (and run for real on 2.0.28) with `@opencode/client` / `@opencode/plugin`
2.0.27 pinned. Other versions are reported by `ocd status` / `ocd doctor` as
untested, but are not refused.

## Verification status

| Check                                                       | How                                 | Status      |
| ----------------------------------------------------------- | ----------------------------------- | ----------- |
| Request/response shapes compile against the 2.0.27 client   | `vp check` (types)                  | Done        |
| Service discovery and Basic auth                            | `ocd doctor` (`GET /api/info` only) | Done (real) |
| Session create, prompt, inspect, interrupt, reply, wake-ups | `FakeOpenCodeService` tests         | Fakes only  |
| Event stream mapping and reconnect + reconciliation         | `FakeOpenCodeService` tests         | Fakes only  |
| One real worker task end to end                             | Real manager dispatch on 2.0.28     | Done        |
| Plugin loading in a real OpenCode host                      | Package directory with `server.js`  | Done        |

## Mapping

- **Workers** are sessions in the user's OpenCode background service
  (`Service.discover`, never `ensure`): `session.create` with
  `location.directory` = the task worktree, `model` parsed from
  `provider/model#variant`, the profile's agent, and metadata
  `{ ocdTaskId, ocdRunId, ocdMarker }`. The marker is also in the title so a
  crash between create and persist can be recovered by `session.list` search.
- A session-level rule `external_directory: ask` makes edits outside the
  worktree surface as permission requests.
- **Prompting** uses `session.prompt(..., resume: true)`. Sessions outlive the
  supervisor (`sessionsSurviveSupervisor = true`), so a restart reattaches.
- **Inspect** combines `session.get` (404 → missing), `session.active`,
  `permission.list`, `session.form.list` and the newest messages (prompted,
  last assistant text, assistant error). 429 / quota-like errors are classified
  as usage-limit waits.
- **Permissions** are answered with `once` or `reject` only, never `always`.
  Forms (questions) are answered through their first string field or cancelled.
- **Events** come from one `event.subscribe` stream. It has no replay, so after
  every reconnect (`server.connected`) the supervisor reconciles live tasks.
  Only sessions the adapter created, found, or inspected are forwarded.
- **Manager wake-ups** use `session.synthetic(..., delivery: "queue", resume:
  true)` so updates do not impersonate the human.

## Known gaps

- The service-level `permission.reply` with `reject` rejects all of that
  session's pending requests (documented OpenCode behaviour).
- Token/cost usage is not reported yet (`usage` capability is false).
- `retry` session status (provider back-off) is treated as activity, not a stall.
