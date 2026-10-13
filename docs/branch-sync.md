# Branch sync

Parallel tasks branch off the repository's base and drift from it while they
run. The branch-sync watchdog makes that drift visible and, when you opt in,
brings idle task branches up to date at safe points. It **reduces** drift and
late surprises; it does not prevent merge conflicts, and it never resolves
one.

## Configuration

Off by default. Enable it globally or per repository in `ocd.jsonc`:

```jsonc
{
  "branchSync": {
    "mode": "detect", // default for every repo: off | detect | refresh
    "intervalMs": 300000, // how often branches are compared (restart to apply)
    "maxTasksPerTick": 25, // at most this many tasks per pass
  },
  "repos": {
    "myapp": { "path": "~/code/myapp", "baseRef": "main", "branchSync": "refresh" },
  },
}
```

- The tracked integration branch is the repository's `baseRef`. A repository
  without one is reported as `skipped` ("baseRef is not set"): OCD does not
  guess which branch your primary checkout means.
- `repos.<name>.branchSync` overrides `branchSync.mode`. Both apply on save;
  `intervalMs` and `maxTasksPerTick` need a restart.
- OCD **never fetches**. `baseRef` is resolved locally, so `origin/main` only
  moves when you fetch, and `main` when you commit or pull in your checkout.

### Modes

| Mode      | What it does                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`     | Nothing. No git command runs.                                                                                                                                                                        |
| `detect`  | Read-only. Each open task shows how many base commits its branch lacks and whether merging the base would conflict. Conflicts on idle tasks raise one attention item. No branch is changed.          |
| `refresh` | `detect`, plus: eligible branches (below) are fast-forwarded, or get a merge commit of the base, when that merges cleanly and the worktree is clean. Ineligible ones keep a pending `behind` status. |

## What gets refreshed, and when

Only in `refresh` mode, only a task's own worktree and branch (`ocd/<task>`
under `~/.ocd/workspaces/<repo>/<task>`), and only at these points:

| Task state                           | Periodic pass                 | Boundary that refreshes it                                                              |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| `queued` with a worktree             | yes                           | just before the worker is launched (relaunch)                                           |
| `ready_for_review`                   | no: reported stale only       | a follow-up (`ocd task send` / `ocd_send_to_worker`), which already re-opens the review |
| `manual`                             | no                            | `ocd task giveback --mode continue`, before the worker is prompted                      |
| `starting/running/blocked`           | no: a worker is active        | none while live; after it finishes, the review follow-up above                          |
| `needs_attention/interrupted/failed` | no: the last run is uncertain | an explicit `ocd task resume --mode relaunch` (it becomes `queued`)                     |
| `completed`, `cancelled`             | not checked at all            | never                                                                                   |

A fresh task needs nothing: its worktree is created from the current base.
When a boundary refreshes a branch, the worker's next prompt starts with a note
saying so, and it reports and is verified again afterwards. A boundary refresh
never blocks the action: if it cannot refresh, the action proceeds and the
status says why.

## How a branch is refreshed

1. **Probe (read-only).** Ownership: the task branch is `ocd/<task>`, the
   worktree path is OCD's own for the task, it is registered in `git worktree
   list` with that branch checked out, and it is not the primary checkout. No
   git operation is in progress (merge, rebase, cherry-pick, revert, bisect,
   `index.lock`). `baseRef` resolves to a commit and is not an OCD task branch
   (`refs/heads/ocd/*`), so unaccepted sibling work is never integrated. The
   task's recorded base is still an ancestor of the base tip (otherwise the
   base was rewritten or retargeted, and nothing is merged). Conflicts are
   predicted with `git merge-tree --write-tree`, which merges in memory; it
   writes only unreferenced objects (collected by `git gc`), never the
   worktree, index or refs. The result is cached per (branch head, base tip).
2. **Eligibility.** Mode and state/trigger as above; no uncommitted or
   untracked files (OCD never stashes); no ignored file that the update would
   overwrite (git overwrites those silently, so OCD refuses).
3. **Re-check under locks.** The whole check and write runs under the task's
   lock, which every lifecycle action (launch, resume, send, take over, give
   back, accept, cancel, cleanup, merge) also takes, plus a per-repository lock
   for git writes. Just before writing, the task state, branch head, base tip,
   in-progress markers and cleanliness are read again; any change defers the
   refresh to the next pass.
4. **Write.** An intent is recorded first. The branch then moves only through
   `git merge --ff-only`: straight to the base tip when the branch has no
   commits of its own, otherwise to a merge commit (`Merge <base> into
   ocd/<task>`) built with `git commit-tree` from the clean in-memory merge.
   `--ff-only` refuses to overwrite local changes, so a failed write leaves the
   worktree as it was and is reported as `error`. Repository hooks are not run
   (`core.hooksPath=/dev/null`); your git identity and signing settings apply.
5. **Record.** The task's recorded base moves to the merged base tip, so OCD's
   verification keeps showing only the task's own changes, and a
   `branch_sync.refreshed` event keeps the old and new heads.

Never: push, fetch, rebase, reset, stash, force anything, rewrite published
history, resolve or auto-merge conflicts, touch the primary checkout or a
worktree OCD did not create for the task, or merge another task's branch.

## Status and attention

Every checked task carries `branchSync` (in `ocd task show`, `ocd task list`
markers like `[3 behind main]` / `[base conflict]`, and the manager's
`ocd_inspect_task`):

| State      | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `current`  | The branch contains the base tip (possibly because OCD just refreshed it).               |
| `behind`   | The base advanced; the reason says why it is not refreshed yet and until when.           |
| `conflict` | Merging the base would conflict in the listed files. The branch was left unchanged.      |
| `skipped`  | Not safe to evaluate (ownership, missing worktree or ref, git operation in progress...). |
| `error`    | A git command failed; the reason has the message.                                        |

A conflict on an idle task (not running, not manual) raises one `decision`
attention item for the manager, notifies you once, and is not raised again for
the same branch head and base tip, even after it is acknowledged. A new base
tip that still conflicts updates or raises one item; once the branch contains
the base, the item is resolved. To integrate, send the worker a follow-up
asking it to merge the base and resolve the conflicts, or do it by hand.

## Limitations

- Conflict prediction is textual; semantic conflicts (code that merges cleanly
  but breaks) are found only by the worker's checks and your review.
- Live tasks drift until they are idle. A reviewed task is refreshed only by a
  follow-up, so an accepted branch may still need a merge in its pull request.
- Merge commits appear in the task branch's history; a squash-merged pull
  request hides them.
- A renamed repository's existing worktrees no longer match OCD's path for the
  task and are reported as `skipped`.
- Untracked or ignored files the update would touch, and any dirty file at all,
  block a refresh until you deal with them.

## Recovery

- **Crash during a refresh.** The intent is recorded before the git write. On
  the next pass OCD finishes the record if the branch is at the intended
  commit, or drops the intent if the write never happened. Nothing is retried
  blindly.
- **Undoing a refresh.** It is an ordinary fast-forward or merge commit, and
  `branch_sync.refreshed` / `branchSync.lastRefresh.from` record the previous
  head. Before anything is built on it, `git -C <worktree> reset --keep <from>`
  restores it (by hand; OCD never resets).
- **`skipped` because of a git operation in progress.** Finish or abort it in
  the worktree yourself; OCD never aborts it for you.
- **Turning it off.** Set the mode to `off` (globally or per repo) and save; no
  further git commands run. Statuses already recorded stay visible.
