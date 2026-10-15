import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { Exec } from "./exec.ts";
import { assetsDir, ICON_FILES } from "./index.ts";
import { ensureNotifierApp, terminalNotifierApp } from "./notifier-app.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "ocd-notifier-"));
  dirs.push(d);
  return d;
}

/** A terminal-notifier.app plus Homebrew's wrapper script pointing into it. */
function fakeInstall(root: string) {
  const app = join(root, "Cellar/terminal-notifier/3.1.0/terminal-notifier.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/terminal-notifier"), "binary");
  writeFileSync(join(app, "Contents/Info.plist"), "<plist/>");
  writeFileSync(join(app, "Contents/Resources/Terminal.icns"), "old icon");
  const wrapper = join(root, "bin/terminal-notifier");
  mkdirSync(join(root, "bin"));
  writeFileSync(wrapper, `#!/bin/bash\nexec "${app}/Contents/MacOS/terminal-notifier" "$@"\n`);
  chmodSync(wrapper, 0o755);
  const icns = join(root, "ocd.icns");
  writeFileSync(icns, "ocd icon");
  return { app, wrapper, icns };
}

describe("OCD's notifier app", () => {
  it("finds terminal-notifier.app behind Homebrew's wrapper script or a direct binary", () => {
    const root = temp();
    const { app, wrapper } = fakeInstall(root);
    expect(terminalNotifierApp(wrapper)).toMatch(/terminal-notifier\.app$/);
    expect(terminalNotifierApp(join(app, "Contents/MacOS/terminal-notifier"))).toMatch(
      /terminal-notifier\.app$/,
    );
    expect(terminalNotifierApp(join(root, "missing"))).toBeNull();
  });

  it("copies the app with OCD's bundle id, name and icon, signs it, and reuses it until something changes", async () => {
    const root = temp();
    const { wrapper, icns } = fakeInstall(root);
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const home = join(root, "home");
    const binary = await ensureNotifierApp({ terminalNotifier: wrapper, icns, home, exec });
    expect(binary).toBe(join(home, "notifier/OCD.app/Contents/MacOS/terminal-notifier"));
    const iconFile = calls
      .find((c) => c[2]?.startsWith("Set :CFBundleIconFile "))![2]!
      .slice("Set :CFBundleIconFile ".length);
    expect(iconFile).toMatch(/^OCD-[0-9a-f]{12}$/);
    expect(
      readFileSync(join(home, `notifier/OCD.app/Contents/Resources/${iconFile}.icns`), "utf8"),
    ).toBe("ocd icon");
    const plistEdits = calls.filter((c) => c[0] === "/usr/libexec/PlistBuddy").map((c) => c[2]);
    expect(plistEdits).toEqual(
      expect.arrayContaining(["Set :CFBundleIdentifier dev.ocd.notifier", "Set :CFBundleName OCD"]),
    );
    expect(calls.some((c) => c[0] === "/usr/bin/codesign" && c.includes("--sign"))).toBe(true);

    // Unchanged: reused without touching anything.
    calls.length = 0;
    expect(await ensureNotifierApp({ terminalNotifier: wrapper, icns, home, exec })).toBe(binary);
    expect(calls).toEqual([]);
    // A new icon rebuilds it.
    writeFileSync(icns, "new ocd icon");
    await ensureNotifierApp({ terminalNotifier: wrapper, icns, home, exec });
    expect(calls.some((c) => c[0] === "/usr/bin/codesign")).toBe(true);
  });

  it("falls back to plain terminal-notifier when the copy cannot be signed", async () => {
    const root = temp();
    const { wrapper, icns } = fakeInstall(root);
    const exec: Exec = async (cmd) =>
      cmd === "/usr/bin/codesign"
        ? { code: 1, stdout: "", stderr: "no" }
        : { code: 0, stdout: "", stderr: "" };
    const home = join(root, "home");
    expect(await ensureNotifierApp({ terminalNotifier: wrapper, icns, home, exec })).toBeNull();
    expect(existsSync(join(home, "notifier/OCD.app.tmp"))).toBe(false);
  });

  it("ships the icon next to the CLI", () => {
    const dir = assetsDir(new URL("../ocd.ts", import.meta.url).href);
    for (const file of Object.values(ICON_FILES)) expect(existsSync(join(dir, file))).toBe(true);
  });
});
