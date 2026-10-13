<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown,
Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management,
package management, and frontend tooling in a single global CLI called `vp`.
Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and
`vp build`. Run `vp help` to print a list of commands and `vp <command> --help`
for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at
https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json`
script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so
`vp dev` and `vp run dev` may do different things. Check `package.json` and
`vite.config.ts` first, and run `vp run <name>` when the project defines a
script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts
      necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run
      `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## OCD project

- Read `PLAN.md` before changing the control plane. Milestones 1–5 are
  implemented in `packages/` (core, adapters, supervisor, plugin, cli). Repos,
  profiles and the manager directory are declared in `ocd.jsonc`.
- Use Drizzle ORM with SQLite, not Kysely. Add runtime dependencies alongside
  their implementation and review generated migrations.
- Use TypeScript 7 and its built-in `tsc` LSP. Keep editor tools pinned locally.
- Use OpenCode V2 interfaces. Keep the plugin thin and database-free; only the
  supervisor writes orchestration state.
- Package Node code with `vp pack` / `pnpm run build`, not the browser's
  `vp build`.
- Use `vite-plus/test` imports and fake adapters for routine tests. Real harness
  runs and LaunchAgent/global plugin installation require explicit
  authorization.
- Preserve workspaces and user changes. No autonomous merges or blind retries of
  uncertain coding runs. Permission auto-approval exists only as the explicit
  per-profile `"permissionPolicy": "allow"` / `"yolo"` opt-ins; never make
  either a default.
