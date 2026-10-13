/** Desktop notifications. Concrete backends live in the CLI's platform layer. */
export interface Notifier {
  notify(message: { title: string; body: string }): Promise<void>;
}

/** The external channel that wakes the registered manager session. */
export interface ManagerChannel {
  wake(sessionId: string, text: string): Promise<void>;
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
