# Adding a harness

A harness is an adapter (drives the tool) plus a descriptor (says what OCD needs
to know about it). Nothing outside `packages/adapters` names a harness; a test
(`seam.test.ts`) fails if one does.

1. **Write the adapter** in `packages/adapters/src/<name>.ts`: a class that
   implements `HarnessAdapter` (`types.ts`). Start from `claude.ts` (a process
   per session) or `opencode.ts` (an external service). Set `capabilities.todos`
   when it emits `todos` events, and implement the optional methods it can
   support (`transcript()` for `ocd task peek`, `revive()`, ...); report subscription
   limits with `limits` events, or `readLimits()` if they can be read without a
   model call.
2. **Write the descriptor** in `packages/adapters/src/<name>-harness.ts`, a
   `HarnessDescriptor` (`harness.ts`):
   - `name` (the `harness` value in profiles and the `ocd.jsonc` section),
     `label`, `binary`, `profileName` (what `ocd setup` calls its profile);
   - `config`: whether it is on by default, the `enabled` description, and any
     string options (`binary`, ...), or `null` for a test harness;
   - `create(ctx)`: builds the adapter from `ctx.settings` (the section),
     `ctx.findBinary`, `ctx.idleStopMs`, `ctx.onError`;
   - `sessionsSurviveSupervisor`, and `usageLimits` if it reports them;
   - `login`: a read-only command that succeeds when logged in (for setup);
   - `models`: a required `format`, a read-only `list` command and its parser
     (used by `ocd doctor` and `ocd setup`; no tokens), or `aliases` when the
     tool cannot list its models.
3. **Register it**: add the descriptor to `HARNESSES` in
   `packages/adapters/src/registry.ts` and export the new files from
   `index.ts`.
4. **Regenerate the config schema**: `pnpm run schema`.
5. **Test it** like the others (fake binary in `test-fixtures` or a fake
   service); the registry test already checks that every descriptor builds an
   adapter carrying its own name.

That is all: the config section, profile validation (an unknown harness is an
error naming the known ones), dispatch, `ocd doctor`, `ocd setup`, usage lines
and the JSON schema pick the harness up from the registry.

Hosting the manager is a separate role and not part of this: only OpenCode can
do it (`manager-host.ts`).
