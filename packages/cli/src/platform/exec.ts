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
 * Directories that service managers (launchd, systemd) leave off their minimal
 * PATH but where user tools live: installers for Claude Code and Codex use
 * ~/.local/bin, Homebrew uses /opt/homebrew/bin or /usr/local/bin.
 */
export function extraBinDirs(platform: NodeJS.Platform = process.platform): string[] {
  const dirs = [join(homedir(), ".local", "bin")];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  else dirs.push("/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin");
  return dirs;
}

/** The PATH a background service runs with: the pinned Node's directory first. */
export function servicePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const dirs = [
    join(nodePath, ".."),
    ...extraBinDirs(platform),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

/**
 * Absolute path of a binary: the configured one, else PATH plus the platform's
 * usual user bin directories. Returns null when it is nowhere to be found.
 */
export function locateBinary(name: string, configured?: string): string | null {
  if (configured) return configured;
  const dirs = [...(process.env["PATH"] ?? "").split(delimiter), ...extraBinDirs()];
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
