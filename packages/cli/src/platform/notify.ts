import { spawn } from "node:child_process";

import { plainText, redact, truncate } from "@ocd/core";
import type { Notifier } from "@ocd/supervisor";

import { execCommand, shellQuote, type Exec } from "./exec.ts";

export interface DesktopNotifier extends Notifier {
  /** Backend name and whether clicking runs the click command; shown by `ocd doctor`. */
  readonly backend: string;
  readonly clickable: boolean;
}

/**
 * Every backend receives plain text: no secrets, escape sequences or control
 * characters, a one-line title, and no leading "-" that a backend's argument
 * parser could take for an option.
 */
function clean(message: { title: string; body: string }): { title: string; body: string } {
  const text = (value: string, multiline: boolean, max: number) =>
    truncate(redact(plainText(value, { multiline })).replace(/^-+\s*/, ""), max);
  return { title: text(message.title, false, 120), body: text(message.body, true, 400) };
}

async function run(exec: Exec, cmd: string, args: string[]): Promise<void> {
  const result = await exec(cmd, args);
  if (result.code !== 0)
    throw new Error(
      `${cmd} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

/**
 * macOS fallback through osascript. Text is passed as argv, never interpolated
 * into the script, so it cannot inject AppleScript. Clicking opens Script Editor
 * (an osascript limitation), so terminal-notifier is preferred when installed.
 */
export class OsascriptNotifier implements DesktopNotifier {
  readonly backend = "osascript";
  readonly clickable = false;
  private readonly exec: Exec;

  constructor(options: { exec?: Exec } = {}) {
    this.exec = options.exec ?? execCommand;
  }

  notify(message: { title: string; body: string }): Promise<void> {
    const { title, body } = clean(message);
    return run(this.exec, "/usr/bin/osascript", [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      body,
    ]);
  }
}

/** macOS via terminal-notifier, which runs a shell command when the notification is clicked. */
export class TerminalNotifier implements DesktopNotifier {
  readonly backend = "terminal-notifier";
  readonly clickable: boolean;
  private readonly binary: string;
  private readonly onClick: readonly string[] | null;
  private readonly exec: Exec;

  constructor(options: { binary: string; onClick?: readonly string[] | undefined; exec?: Exec }) {
    this.binary = options.binary;
    this.onClick = options.onClick ?? null;
    this.clickable = this.onClick !== null;
    this.exec = options.exec ?? execCommand;
  }

  async notify(message: { title: string; body: string }): Promise<void> {
    const { title, body } = clean(message);
    const args = ["-title", title, "-message", body];
    if (this.onClick) args.push("-execute", shellQuote(this.onClick));
    const result = await this.exec(this.binary, args);
    const output = `${result.stderr} ${result.stdout}`.trim();
    // Without macOS notification permission it prints this (exit 3 in 3.x).
    if (result.code !== 0 || /not allowed|turned off|could not request/i.test(output))
      throw new Error(`terminal-notifier: ${output || `exited ${result.code}`}`);
  }
}

/** How long a clickable Linux notification keeps its notify-send process waiting for a click. */
const CLICK_WAIT_MS = 30 * 60_000;

/**
 * Linux via libnotify's notify-send. With an action (notify-send 0.7.9+) the
 * process waits for the click, prints the action name, and OCD then runs the
 * click command; the notification itself is delivered as soon as it spawns.
 */
export class NotifySendNotifier implements DesktopNotifier {
  readonly backend = "notify-send";
  readonly clickable: boolean;
  private readonly binary: string;
  private readonly onClick: readonly string[] | null;
  private readonly exec: Exec;
  private readonly graceMs: number;
  private readonly icon: string | null;

  constructor(options: {
    binary: string;
    onClick?: readonly string[] | undefined;
    supportsActions: boolean;
    exec?: Exec;
    /** How long to wait for an immediate failure before calling it delivered. */
    graceMs?: number;
    /** Image file shown with the notification (OCD's icon). */
    icon?: string;
  }) {
    this.icon = options.icon ?? null;
    this.graceMs = options.graceMs ?? 750;
    this.binary = options.binary;
    this.onClick = options.supportsActions ? (options.onClick ?? null) : null;
    this.clickable = this.onClick !== null;
    this.exec = options.exec ?? execCommand;
  }

  notify(message: { title: string; body: string }): Promise<void> {
    const { title, body } = clean(message);
    const args = ["--app-name=OCD", ...(this.icon ? [`--icon=${this.icon}`] : []), title, body];
    const onClick = this.onClick;
    if (!onClick) return run(this.exec, this.binary, args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["--action=default=Open", "--wait", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      let reported = false;
      let grace: NodeJS.Timeout | undefined;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (errors.length < 4000) errors += chunk;
      });
      const timer = setTimeout(() => child.kill(), CLICK_WAIT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(grace);
        reported = true;
        reject(error);
      });
      // Delivered once it has survived the grace period; a notify-send that
      // fails right away (no daemon, bad option) must not look delivered.
      child.once("spawn", () => {
        grace = setTimeout(() => {
          reported = true;
          resolve();
        }, this.graceMs);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        clearTimeout(grace);
        if (!reported) {
          reported = true;
          if (code !== 0)
            reject(new Error(`${this.binary} exited ${code}: ${errors.trim() || output.trim()}`));
          else resolve();
        }
        if (output.trim().split("\n").includes("default")) {
          const [cmd, ...rest] = onClick;
          if (cmd)
            spawn(cmd, rest, { detached: true, stdio: "ignore" })
              .on("error", () => undefined)
              .unref();
        }
      });
      // A pending click must not keep the supervisor alive at shutdown.
      child.unref();
      (child.stdout as unknown as { unref?: () => void }).unref?.();
      (child.stderr as unknown as { unref?: () => void }).unref?.();
    });
  }
}

/**
 * Tries the preferred backend and falls back when it fails, so a notification
 * is never lost to a backend problem (e.g. terminal-notifier without macOS
 * notification permission). The preferred backend is tried again every time,
 * so granting the permission takes effect without a restart.
 */
export class FallbackNotifier implements DesktopNotifier {
  readonly backend: string;
  readonly clickable: boolean;
  /** The preferred backend's most recent failure; null after it works. */
  lastError: Error | null = null;
  private readonly preferred: DesktopNotifier;
  private readonly fallback: DesktopNotifier;

  constructor(preferred: DesktopNotifier, fallback: DesktopNotifier) {
    this.preferred = preferred;
    this.fallback = fallback;
    this.backend = `${preferred.backend}, falling back to ${fallback.backend}`;
    this.clickable = preferred.clickable;
  }

  async notify(message: { title: string; body: string }): Promise<void> {
    try {
      await this.preferred.notify(message);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      await this.fallback.notify(message);
    }
  }
}

export class NoDesktopNotifier implements DesktopNotifier {
  readonly backend: string;
  readonly clickable = false;

  constructor(reason: string) {
    this.backend = `none (${reason})`;
  }

  async notify(): Promise<void> {}
}
