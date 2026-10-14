import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Runs a command to completion; never rejects (a failure is a non-zero code). */
export const execCommand: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Where user tools are commonly installed (standalone installers, Homebrew,
 * Nix): the fallback when the login shell's PATH could not be read.
 */
export function commonBinDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const dirs = [join(home, ".local", "bin"), join(home, "bin")];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  else dirs.push("/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/snap/bin");
  dirs.push(join(home, ".nix-profile", "bin"), "/nix/var/nix/profiles/default/bin");
  if (platform !== "darwin") dirs.push("/run/current-system/sw/bin");
  return dirs;
}

/**
 * The base PATH a background service starts with: the pinned Node's directory
 * first. The supervisor extends it with the login shell's PATH at startup.
 */
export function servicePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const dirs = [
    join(nodePath, ".."),
    ...commonBinDirs(platform),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

/**
 * Absolute path of a binary: the configured one, else PATH plus the common
 * install locations. Returns null when it is nowhere to be found.
 */
export function locateBinary(name: string, configured?: string): string | null {
  if (configured) return configured;
  const dirs = [...(process.env["PATH"] ?? "").split(delimiter), ...commonBinDirs()];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Like locateBinary, falling back to the bare name (resolved by PATH at spawn time). */
export function findBinary(name: string, configured?: string): string {
  return locateBinary(name, configured) ?? name;
}

/** Quotes argv for `/bin/sh -c`. */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
}
