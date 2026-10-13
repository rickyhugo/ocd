import { execFile } from "node:child_process";

import { redact, truncate } from "@ocd/core";

export interface Notifier {
  notify(message: { title: string; body: string }): Promise<void>;
}

/** The external channel that wakes the registered manager session. */
export interface ManagerChannel {
  wake(sessionId: string, text: string): Promise<void>;
}

/**
 * macOS desktop notifications through osascript. Text is passed as argv, never
 * interpolated into the script, so it cannot inject AppleScript.
 */
export class MacNotifier implements Notifier {
  notify(message: { title: string; body: string }): Promise<void> {
    const title = truncate(redact(message.title), 120);
    const body = truncate(redact(message.body), 400);
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/osascript",
        [
          "-e",
          "on run argv",
          "-e",
          "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          body,
        ],
        { timeout: 10_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
}

export class NullNotifier implements Notifier {
  async notify(): Promise<void> {}
}

export class RecordingNotifier implements Notifier {
  readonly sent: { title: string; body: string }[] = [];
  failNext = 0;

  async notify(message: { title: string; body: string }): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("Simulated notification failure");
    }
    this.sent.push(message);
  }
}

export class RecordingManagerChannel implements ManagerChannel {
  readonly sent: { sessionId: string; text: string }[] = [];
  failNext = 0;

  async wake(sessionId: string, text: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("Simulated wake failure");
    }
    this.sent.push({ sessionId, text });
  }
}
