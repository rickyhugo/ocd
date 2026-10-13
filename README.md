# OCD

A local agent control plane: one OpenCode manager, durable task and memory state,
and notifications when work needs human attention.

**Status:** planning and Node tooling skeleton only. No supervisor, harness
adapters, plugin, database, or background service is implemented or installed yet.

See [PLAN.md](PLAN.md) for the architecture, safety boundaries, implementation
milestones, and acceptance tests.

## Stack

- Node.js 24 and pnpm, pinned in `mise.toml`.
- Strict TypeScript 7 ESM and Vite+ for checking, testing, and packaging.
- Planned: Fastify, Zod, Pino, SQLite via `better-sqlite3`, **Drizzle ORM**, and
  reviewed Drizzle Kit migrations.
- Planned: OpenCode V2 plugin/client, Claude Code CLI, and Codex app-server adapters.
- Planned: a user LaunchAgent on macOS; no Docker or web application.

Runtime dependencies will be added with their implementations, not preinstalled
as unused placeholders.

## Development

With the pinned mise tools installed:

```sh
mise exec -- pnpm install
mise exec -- pnpm run check
mise exec -- pnpm run build
mise exec -- pnpm run dev
```

`dev` watches the Node package build; it does not start a browser dev server or a
supervisor. `build` uses `vp pack`, not the web application's `vp build`.

`pnpm test` is configured for Vitest's Node environment. There are no tests yet;
the normal command intentionally fails when no tests are found. During this
planning-only scaffold, validate the runner with:

```sh
mise exec -- pnpm exec vp test --passWithNoTests
```

Do not retain `--passWithNoTests` as the implementation's test policy.

## Neovim

`.nvim-tools.lua` configures the existing `project-tools` plugin:

- `tsc` uses the repo-local TypeScript 7 compiler's built-in language server.
- `oxlint` runs as an LSP, without duplicate nvim-lint diagnostics.
- `oxfmt` formats JS/TS, JSON/JSONC, YAML, and Markdown on save.
- Language server and formatter versions are locked in `package.json` and
  `pnpm-lock.yaml`; Oxc versions match the pinned Vite+ toolchain.
- Other tools such as Lua/TOML support remain inherited from the global config.

Open a TypeScript file and use `:ProjectTools show` or `:ProjectTools health`.
The configuration is declarations-only, as required by `project-tools`.
