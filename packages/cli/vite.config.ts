import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  pack: {
    entry: { ocd: "src/ocd.ts" },
    platform: "node",
    target: "node24",
    format: ["esm"],
    dts: false,
    sourcemap: true,
    // Dependencies (including workspace packages) stay external and resolve to their built dist.
  },
});
