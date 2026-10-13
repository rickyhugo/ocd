import { execFile } from "node:child_process";

/**
 * The first process (other than this one) whose command line mentions
 * `needle`, e.g. an interactive `claude --resume <session id>`. Best effort: a
 * session opened without its id on the command line is not found.
 */
export function processMentioning(
  needle: string,
): Promise<{ pid: number; command: string } | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,args="],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        for (const line of String(stdout).split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!match || !match[2]!.includes(needle)) continue;
          const pid = Number(match[1]);
          if (pid === process.pid) continue;
          return resolve({ pid, command: match[2]!.slice(0, 200) });
        }
        resolve(null);
      },
    );
  });
}
