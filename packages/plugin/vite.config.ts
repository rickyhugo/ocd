import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  pack: {
    entry: ["src/index.ts"],
    platform: "node",
    target: "node24",
    format: ["esm"],
    dts: true,
    sourcemap: true,
    // Self-contained except for the host SDK, which OpenCode provides and must not be bundled.
    noExternal: [/^@ocd\//, "zod"],
    external: [/^@opencode\//, "effect"],
  },
});
