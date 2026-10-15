import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { MANAGER_HOST } from "./manager-host.ts";
import { HARNESSES } from "./registry.ts";

// The harness seam: outside this package, no code names a specific harness.
// Everything that differs between harnesses lives in a descriptor (harness.ts)
// next to its adapter; the one exception is the manager host (manager-host.ts).
// This keeps harness-specific literals from creeping back in.

const packages = join(import.meta.dirname, "..", "..");

// The manager host (OpenCode) may be named in prose and paths where its role
// as host is the point: the plugin is an OpenCode plugin, setup installs it
// into OpenCode's config, and focusing the manager finds an OpenCode pane.
// Quoted "opencode" literals are still forbidden everywhere.
const MANAGER_HOST_FILES = ["plugin/", "cli/src/setup.ts", "cli/src/platform/focus.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "test-fixtures"
        ? []
        : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Source without comments (prose may name harnesses; code and strings may not). */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

const outside = ["core", "supervisor", "cli", "plugin"].flatMap((name) => {
  const root = join(packages, name);
  return [
    ...sources(join(root, "src")),
    ...sources(root).filter((p) => p.endsWith(".tsx") && !p.includes(`${join(root, "src")}/`)),
  ];
});

describe("harness seam", () => {
  it("finds the sources it guards", () => {
    expect(outside.length).toBeGreaterThan(30);
  });

  it("does not name a specific harness outside the adapters package", () => {
    const names = HARNESSES.map((h) => h.name).filter((n) => n !== "fake");
    const offenders = outside.flatMap((path) => {
      const text = code(path);
      const host = MANAGER_HOST_FILES.some((f) => relative(packages, path).startsWith(f));
      const hits = [
        ...names
          .filter((n) => n !== MANAGER_HOST.harness || !host)
          .filter((n) => new RegExp(n, "i").test(text))
          .map((n) => `mentions ${n}`),
        ...names
          .filter((n) => new RegExp(`["'\`]${n}["'\`]`).test(text))
          .map((n) => `"${n}" literal`),
        ...(/\binstanceof\s+\w*Adapter\b/.test(text) ? ["instanceof an adapter"] : []),
      ];
      return hits.length ? [`${relative(packages, path)}: ${[...new Set(hits)].join(", ")}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
