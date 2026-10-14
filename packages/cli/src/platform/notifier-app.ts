import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { execCommand, type Exec } from "./exec.ts";

// macOS takes a notification's icon from the app bundle that sends it, with
// no way to override it per notification. So OCD's notifications come from
// its own copy of terminal-notifier: same binary, its own bundle identifier,
// name ("OCD") and icon. Like any new sender, macOS asks once for permission.

export const NOTIFIER_BUNDLE_ID = "dev.ocd.notifier";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** The terminal-notifier.app a `terminal-notifier` command runs (Homebrew installs a wrapper script). */
export function terminalNotifierApp(binary: string): string | null {
  let real: string;
  try {
    real = realpathSync(binary);
  } catch {
    return null;
  }
  const inBundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(real);
  if (inBundle) return inBundle[1]!;
  try {
    const script = readFileSync(real, "utf8").slice(0, 4096);
    const target = /"?(\/[^"\s]+\.app)\/Contents\/MacOS\/terminal-notifier"?/.exec(script);
    return target && existsSync(target[1]!) ? target[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Makes (or reuses) `<home>/notifier/OCD.app` from terminal-notifier.app with
 * OCD's icon, and returns its executable; null when that cannot be done (the
 * caller then uses terminal-notifier as it is). Rebuilt only when the source
 * app or the icon changes.
 */
export async function ensureNotifierApp(options: {
  terminalNotifier: string;
  icns: string;
  home: string;
  exec?: Exec;
}): Promise<string | null> {
  const exec = options.exec ?? execCommand;
  const source = terminalNotifierApp(options.terminalNotifier);
  if (!source || !existsSync(options.icns)) return null;
  const app = join(options.home, "notifier", "OCD.app");
  const binary = join(app, "Contents", "MacOS", "terminal-notifier");
  const stamp = createHash("sha256")
    .update(source)
    .update(readFileSync(join(source, "Contents", "Info.plist")))
    .update(readFileSync(options.icns))
    .digest("hex");
  const stampFile = join(app, "Contents", "Resources", "ocd-notifier.stamp");
  try {
    if (existsSync(binary) && readFileSync(stampFile, "utf8") === stamp) return binary;
  } catch {
    // rebuild below
  }
  const tmp = `${app}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    cpSync(source, tmp, { recursive: true, dereference: false, verbatimSymlinks: true });
    const plist = join(tmp, "Contents", "Info.plist");
    // Named after the icon's content: macOS caches app icons, and a new file
    // name makes a changed icon a new icon rather than a cached old one.
    const iconName = `OCD-${stamp.slice(0, 12)}`;
    cpSync(options.icns, join(tmp, "Contents", "Resources", `${iconName}.icns`));
    for (const command of [
      `Set :CFBundleIdentifier ${NOTIFIER_BUNDLE_ID}`,
      "Set :CFBundleName OCD",
      `Set :CFBundleIconFile ${iconName}`,
    ]) {
      const r = await exec(PLIST_BUDDY, ["-c", command, plist]);
      if (r.code !== 0) throw new Error(`PlistBuddy ${command}: ${r.stderr || r.stdout}`);
    }
    // An asset-catalog icon name would win over CFBundleIconFile.
    await exec(PLIST_BUDDY, ["-c", "Delete :CFBundleIconName", plist]);
    await exec(PLIST_BUDDY, ["-c", "Add :CFBundleDisplayName string OCD", plist]);
    writeFileSync(join(tmp, "Contents", "Resources", "ocd-notifier.stamp"), stamp);
    // The copy's contents changed, so it is signed again (ad hoc, as Homebrew's is).
    const signed = await exec("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", tmp]);
    if (signed.code !== 0) throw new Error(`codesign: ${signed.stderr || signed.stdout}`);
    rmSync(app, { recursive: true, force: true });
    renameSync(tmp, app);
    // A fresh modification time tells LaunchServices the bundle changed.
    const now = new Date();
    utimesSync(app, now, now);
    // Let LaunchServices pick up the new icon now rather than whenever it rescans.
    await exec(LSREGISTER, ["-f", app]);
    return binary;
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    return existsSync(binary) ? binary : null;
  }
}

/** Assets shipped with the CLI (packages/cli/assets), given the CLI module's own URL. */
export function iconAssets(moduleUrl: string): { icns: string; png: string } {
  const dir = join(dirname(fileURLToPath(moduleUrl)), "..", "assets");
  return { icns: join(dir, "ocd.icns"), png: join(dir, "ocd-icon.png") };
}
