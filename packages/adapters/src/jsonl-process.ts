import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

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
    },
  ) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
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
      options.onMessage(message);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString("utf8"));
      while (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    // EPIPE on stdin after the child exits is reported through `exited`.
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.stderrTail.push(String(error));
        this.exitInfo ??= { code: null, signal: null };
        resolve(this.exitInfo);
      });
      this.child.on("exit", (code, signal) => {
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
    if (!this.running) throw new Error("Worker process is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Closes stdin, then escalates SIGTERM -> SIGKILL if the process lingers. */
  async stop(graceMs = 3000): Promise<void> {
    if (!this.running) return;
    this.child.stdin.end();
    const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
    if (await Promise.race([this.exited.then(() => true), timeout(graceMs).then(() => false)]))
      return;
    this.child.kill("SIGTERM");
    if (await Promise.race([this.exited.then(() => true), timeout(graceMs).then(() => false)]))
      return;
    this.child.kill("SIGKILL");
    await this.exited;
  }
}
