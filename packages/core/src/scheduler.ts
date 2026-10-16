/** A pending timeout or interval from a `Scheduler`. */
export interface Timer {
  /** Lets the process exit while this timer is pending. */
  unref(): void;
}

/**
 * The time and timers. Supervisor and adapter code reads the time and waits
 * only through a `Scheduler`, so tests can drive both with `FakeScheduler`.
 */
export interface Scheduler {
  /** Milliseconds since the epoch. */
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

interface FakeTimer {
  at: number;
  every: number | null;
  fn: () => void;
  order: number;
}

/** Virtual time for tests: nothing fires until `advance` moves the clock past it. */
export class FakeScheduler implements Scheduler {
  private time: number;
  private order = 0;
  private readonly timers = new Map<Timer, FakeTimer>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): Timer {
    return this.add(fn, ms, null);
  }

  clearTimeout(timer: Timer): void {
    this.timers.delete(timer);
  }

  setInterval(fn: () => void, ms: number): Timer {
    return this.add(fn, ms, Math.max(1, ms));
  }

  clearInterval(timer: Timer): void {
    this.timers.delete(timer);
  }

  /** Timers that have neither fired (timeouts) nor been cleared. */
  get pending(): number {
    return this.timers.size;
  }

  /**
   * Moves the clock forward by `ms`, firing every timer that comes due in time
   * order. The event loop turns once before the clock moves and after each
   * timer, so promise chains already running (and those a timer starts) settle
   * at the time they started, and the timers they set count from then.
   */
  async advance(ms: number): Promise<void> {
    await turn();
    const until = this.time + ms;
    for (let due = this.next(until); due; due = this.next(until)) {
      const [timer, t] = due;
      this.time = t.at;
      if (t.every === null) this.timers.delete(timer);
      else this.timers.set(timer, { ...t, at: t.at + t.every, order: this.order++ });
      t.fn();
      await turn();
    }
    this.time = until;
    await turn();
  }

  private next(until: number): [Timer, FakeTimer] | undefined {
    let best: [Timer, FakeTimer] | undefined;
    for (const entry of this.timers) {
      const t = entry[1];
      if (t.at > until) continue;
      if (!best || t.at < best[1].at || (t.at === best[1].at && t.order < best[1].order))
        best = entry;
    }
    return best;
  }

  private add(fn: () => void, ms: number, every: number | null): Timer {
    const timer: Timer = { unref: () => undefined };
    this.timers.set(timer, { at: this.time + Math.max(0, ms), every, fn, order: this.order++ });
    return timer;
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
