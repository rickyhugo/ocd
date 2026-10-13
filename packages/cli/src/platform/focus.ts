import { existsSync, realpathSync } from "node:fs";

import type { Exec } from "./exec.ts";
import { configuredTerminal, identifyTerminal, type TerminalApp } from "./terminal.ts";

// `ocd focus`: bring the human to the manager session; the click action of
// OCD's notifications. tmux is the portable part (switch to the pane running
// OpenCode in the manager directory); raising the terminal window is the
// platform's job.

export interface TmuxPane {
  id: string;
  path: string;
  command: string;
  session: string;
  window: string;
}

function canonical(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** The pane in the manager directory, preferring one that runs OpenCode. */
export function managerPane(panes: TmuxPane[], directory: string): TmuxPane | null {
  const dir = canonical(directory);
  const inDir = panes.filter((p) => canonical(p.path) === dir);
  return inDir.find((p) => /opencode|bun|node/i.test(p.command)) ?? inDir[0] ?? null;
}

export function parsePanes(output: string): TmuxPane[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id = "", path = "", command = "", session = "", window = ""] = line.split("\t");
      return { id, path, command, session, window };
    });
}

export interface FocusOptions {
  /** Manager directory from ocd.jsonc; null when none is configured. */
  directory: string | null;
  /** tmux binary, or null when tmux is not installed. */
  tmux: string | null;
  /** notifications.focusApp from ocd.jsonc; overrides tmux's client detection. */
  focusApp?: string | undefined;
  exec: Exec;
  /** Raises the terminal window; false when the platform cannot. */
  activate(app: TerminalApp): Promise<boolean>;
}

/** Focuses the manager session; returns what it did, for the CLI to print. */
export async function focusManager(options: FocusOptions): Promise<string[]> {
  const steps: string[] = [];
  let app = options.focusApp ? configuredTerminal(options.focusApp) : null;
  const tmux = options.tmux;
  if (tmux) {
    const listed = await options.exec(tmux, [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{session_name}\t#{window_id}",
    ]);
    const pane =
      listed.code === 0 && options.directory
        ? managerPane(parsePanes(listed.stdout), options.directory)
        : null;
    if (pane) {
      // Outside tmux these act on the most recently used client.
      await options.exec(tmux, ["switch-client", "-t", pane.id]);
      await options.exec(tmux, ["select-window", "-t", pane.window]);
      await options.exec(tmux, ["select-pane", "-t", pane.id]);
      steps.push(`switched tmux to pane ${pane.id} (session ${pane.session})`);
    } else if (listed.code === 0) {
      steps.push(
        options.directory
          ? `no tmux pane open in ${options.directory}`
          : "no manager directory configured",
      );
    }
    if (!app) {
      const clients = await options.exec(tmux, [
        "list-clients",
        "-F",
        "#{client_termtype}\t#{client_termname}",
      ]);
      if (clients.code === 0) {
        const [termtype = "", termname = ""] = (clients.stdout.split("\n")[0] ?? "").split("\t");
        app = identifyTerminal(termtype, termname);
      }
    }
  }
  if (app) {
    steps.push(
      (await options.activate(app)) ? `raised ${app.name}` : `could not raise ${app.name}`,
    );
  }
  return steps.length ? steps : ["nothing to focus: no tmux and no notifications.focusApp"];
}
