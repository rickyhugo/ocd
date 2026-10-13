import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { GitHubCliStatus } from "@ocd/core";
import { GhError, probeGh, resolveGh, type ProbeGhOptions } from "@ocd/supervisor";

// `ocd doctor` and `ocd service install` run in your shell, but the background
// service runs with its own PATH. These checks compare the two, so "gh works in
// my terminal" and "the supervisor cannot find gh" stop being a mystery.

export interface GhDoctorReport {
  /** gh as this shell (plus gh.binary) sees it, with a bounded login check. */
  shell: GitHubCliStatus;
  /** Where the background service would find gh; null without a service manager. */
  service: { path: string | null; problem: string | null } | null;
  hints: string[];
}

/** mise's shim directory, if mise is installed with shims (stable across gh upgrades). */
export function miseShim(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const data =
    env["MISE_DATA_DIR"] ??
    join(env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "mise");
  const shim = join(data, "shims", name);
  return existsSync(shim) ? shim : null;
}

/** Where the service would find gh with the PATH `ocd service install` writes. */
export function serviceGh(options: { configured: string | null; servicePath: string }): {
  path: string | null;
  problem: string | null;
} {
  try {
    return {
      path: resolveGh({ configured: options.configured, pathEnv: options.servicePath }).path,
      problem: null,
    };
  } catch (error) {
    return { path: null, problem: error instanceof GhError ? error.problem : String(error) };
  }
}

/** Suggestions for making the service find the same gh as the shell. */
export function ghServiceHints(options: {
  configured: string | null;
  shellPath: string | null;
  service: { path: string | null; problem: string | null } | null;
  shim?: string | null;
}): string[] {
  const { configured, shellPath, service } = options;
  if (configured || !service || service.path || !shellPath) return [];
  const suggestion = options.shim ?? shellPath;
  return [
    `the background service's PATH has no gh, but your shell finds ${shellPath}. Add to ocd.jsonc (applies on save):`,
    `  "gh": { "binary": "${suggestion}" }`,
    ...(options.shim && options.shim !== shellPath
      ? ["  (the mise shim keeps working after gh upgrades; the versioned install path does not)"]
      : []),
  ];
}

export async function checkGh(
  options: {
    configured: string | null;
    extraDirs: readonly string[];
    servicePath: string | null;
  },
  probe: (o: ProbeGhOptions) => Promise<GitHubCliStatus> = probeGh,
): Promise<GhDoctorReport> {
  const shell = await probe({
    configured: options.configured,
    extraDirs: options.extraDirs,
    timeoutMs: 10_000,
  });
  const service =
    options.servicePath === null
      ? null
      : serviceGh({ configured: options.configured, servicePath: options.servicePath });
  return {
    shell,
    service,
    hints: ghServiceHints({
      configured: options.configured,
      shellPath: shell.path,
      service,
      shim: shell.path ? miseShim("gh") : null,
    }),
  };
}

/** One line for `ocd status` / `ocd doctor`. */
export function describeGh(status: GitHubCliStatus): string {
  if (!status.available) return `UNAVAILABLE ${status.problems.join("; ")}`;
  const where = `${status.path} (${status.source === "config" ? "gh.binary" : "PATH"})`;
  const auth =
    status.auth === "ok"
      ? "logged in"
      : status.auth === "unknown"
        ? "login not verified"
        : `login ${status.auth}`;
  return [`ok ${status.version ?? ""} ${where}, ${auth}`, ...status.problems].join("; ");
}
