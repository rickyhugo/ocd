import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  pack: {
    entry: ["src/index.ts", "src/testkit.ts"],
    platform: "node",
    target: "node24",
    format: ["esm"],
    dts: true,
    sourcemap: true,
  },
});
