import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const packages = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const platformDir = join(packages, "cli", "src", "platform");

// Names that only the platform layer may know: the OS itself, and the tools
// and services it uses. Everything else asks the `Platform` interface.
const DENY = [
  /process\.platform|os\.platform\(/,
  /\b(darwin|linux|macos|win32)\b/i,
  /terminal-notifier|osascript|notify-send|libnotify|plistbuddy/i,
  /\bhomebrew\b|\bbrew\b|launchctl|launchd|launchagent|systemd|systemctl/i,
  /pbcopy|xdg-open|\.icns\b|~\/Library|\/Library\//i,
];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || path === platformDir) continue;
      yield* sources(path);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield path;
  }
}

describe("platform boundary", () => {
  it("keeps OS-specific names inside packages/cli/src/platform", () => {
    const leaks: string[] = [];
    for (const file of sources(packages)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (DENY.some((re) => re.test(line)))
            leaks.push(`${relative(packages, file).split(sep).join("/")}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(leaks).toEqual([]);
  });
});
