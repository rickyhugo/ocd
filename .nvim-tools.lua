-- Project tools extend ~/.nvim-tools.lua. Binaries are pinned in package.json.
-- tsc uses TypeScript 7's built-in language server from node_modules/.bin.
---@type ProjectToolsConfig
return {
	lsp = { "tsc", "oxlint" },
	format = {
		javascript = { "oxfmt" },
		javascriptreact = { "oxfmt" },
		typescript = { "oxfmt" },
		typescriptreact = { "oxfmt" },
		json = { "oxfmt" },
		jsonc = { "oxfmt" },
		yaml = { "oxfmt" },
		markdown = { "oxfmt" },
		pkl = { "pkl" },
	},
	-- Oxlint runs as an LSP; don't also run it through nvim-lint.
	format_on_save = true,
	lsp_format = "never",
	restart_on = {
		"package.json",
		"pnpm-lock.yaml",
		"tsconfig.json",
		"vite.config.ts",
		"mise.toml",
	},
}
