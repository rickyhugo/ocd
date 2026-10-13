import { defineConfig } from "vite-plus";

export default defineConfig({
  // Workspace packages export their TypeScript sources under the "source" condition.
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"], externalConditions: ["source"] } },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    // Tests open real SQLite files, sockets, and git worktrees in temp dirs.
    testTimeout: 20_000,
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
