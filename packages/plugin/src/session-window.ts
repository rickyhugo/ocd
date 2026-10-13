import { execFile } from "node:child_process";

// Opens a taken-over worker session in its own tmux window, so it keeps
// running after the terminal is closed and the human can come back to it.

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const execCommand: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (error, stdout) =>
      resolve({ code: error ? 1 : 0, stdout: String(stdout) }),
    );
  });

export function windowName(taskId: string): string {
  return `ocd-${taskId.slice(-6)}`;
}

/** Quotes argv for a shell, for showing the command to the human. */
export function shellLine(
  cwd: string,
  command: readonly string[],
  env: Readonly<Record<string, string>> = {},
): string {
  const q = (a: string) => (/^[\w./:@%+=-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);
  const vars = Object.entries(env).map(([k, v]) => `${k}=${q(v)} `);
  return `cd ${q(cwd)} && ${vars.join("")}${command.map(q).join(" ")}`;
}

/**
 * Focuses the task's tmux window, creating it if needed. Returns the window
 * name, or null outside tmux (the caller then shows the command instead).
 */
export async function openSessionWindow(options: {
  taskId: string;
  cwd: string;
  command: readonly string[];
  /** Set in the window: the worker sandbox, so the session never reaches the live OCD. */
  sessionEnv?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
}): Promise<string | null> {
  const env = options.env ?? process.env;
  if (!env["TMUX"]) return null;
  const exec = options.exec ?? execCommand;
  const name = windowName(options.taskId);
  const listed = await exec("tmux", ["list-windows", "-a", "-F", "#{window_id}\t#{window_name}"]);
  const existing = listed.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, n]) => n === name)?.[0];
  if (existing) {
    await exec("tmux", ["switch-client", "-t", existing]);
    await exec("tmux", ["select-window", "-t", existing]);
    return name;
  }
  const vars = Object.entries(options.sessionEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const created = await exec("tmux", [
    "new-window",
    "-n",
    name,
    "-c",
    options.cwd,
    ...vars,
    ...options.command,
  ]);
  if (created.code !== 0) throw new Error(`tmux new-window failed for ${name}`);
  return name;
}
