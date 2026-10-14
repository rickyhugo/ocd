import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Live children, so a supervisor that exits without stop() does not orphan their groups. */
const live = new Set<JsonLineProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const proc of live) proc.killGroup("SIGKILL");
  });
}

/**
 * A child process that speaks newline-delimited JSON on stdio. Used by
 * harnesses whose workers are processes owned by the supervisor (Claude Code,
 * Codex). Only the given environment is passed; nothing else is inherited.
 */
export class JsonLineProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stderrTail: string[] = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      onMessage: (message: unknown) => void;
      onInvalidLine?: (line: string) => void;
      /** An exception thrown by `onMessage`; the stream keeps being read. */
      onError?: (error: unknown) => void;
    },
  ) {
    // Own process group, so stop() can take down grandchildren (dev servers,
    // watchers) too. The exit hook above keeps "workers die with the supervisor".
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        options.onInvalidLine?.(line);
        return;
      }
      // Valid JSON of the wrong shape (null, a number, an array) is not a message.
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        options.onInvalidLine?.(line);
        return;
      }
      // A handler bug must never become an uncaught exception in the supervisor.
      try {
        options.onMessage(message);
      } catch (error) {
        if (options.onError) options.onError(error);
        else options.onInvalidLine?.(line);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString("utf8"));
      while (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    // EPIPE on stdin after the child exits is reported through `exited`.
    this.child.stdin.on("error", () => undefined);
    live.add(this);
    installExitHook();
    this.exited = new Promise((resolve) => {
      this.child.on("error", (error) => {
        live.delete(this);
        this.stderrTail.push(String(error));
        this.exitInfo ??= { code: null, signal: null };
        resolve(this.exitInfo);
      });
      this.child.on("exit", (code, signal) => {
        live.delete(this);
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exitInfo === null;
  }

  stderr(): string {
    return this.stderrTail.join("").slice(-4000);
  }

  send(message: unknown): void {
    if (!this.running || this.child.stdin.writableEnded || this.child.stdin.destroyed)
      throw new Error("Worker process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Closes stdin, then escalates SIGTERM -> SIGKILL if the process lingers. */
  async stop(graceMs = 3000): Promise<void> {
    if (!this.running) return;
    this.child.stdin.end();
    const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
    if (await Promise.race([this.exited.then(() => true), timeout(graceMs).then(() => false)]))
      return;
    this.killGroup("SIGTERM");
    if (await Promise.race([this.exited.then(() => true), timeout(graceMs).then(() => false)])) {
      // The leader is gone; anything it left behind in the group goes too.
      this.killGroup("SIGKILL");
      return;
    }
    this.killGroup("SIGKILL");
    await this.exited;
  }

  /** Signals the whole process group, falling back to the direct child. */
  killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (pid === undefined) throw new Error("no pid");
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // already gone
      }
    }
  }
}
