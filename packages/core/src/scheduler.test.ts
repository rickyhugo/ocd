import { describe, expect, it } from "vite-plus/test";

import { FakeScheduler } from "./scheduler.ts";

describe("FakeScheduler", () => {
  it("fires due timers in time order, repeats intervals, and skips cleared ones", async () => {
    const s = new FakeScheduler(1000);
    const fired: string[] = [];
    const record = (name: string) => () => void fired.push(`${name}@${s.now()}`);
    s.setTimeout(record("late"), 30);
    s.setTimeout(record("early"), 10);
    const every = s.setInterval(record("tick"), 20);
    s.clearTimeout(s.setTimeout(record("cleared"), 5));

    await s.advance(9);
    expect(fired).toEqual([]);
    await s.advance(41);
    expect(fired).toEqual(["early@1010", "tick@1020", "late@1030", "tick@1040"]);
    expect(s.now()).toBe(1050);
    expect(s.pending).toBe(1);
    s.clearInterval(every);
    await s.advance(100);
    expect(fired).toHaveLength(4);
    expect(s.pending).toBe(0);
  });

  it("lets a timer's async work settle before the next timer fires", async () => {
    const s = new FakeScheduler();
    const order: string[] = [];
    s.setTimeout(() => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        order.push("first settled");
      })();
    }, 10);
    s.setTimeout(() => void order.push("second fired"), 10);
    await s.advance(10);
    expect(order).toEqual(["first settled", "second fired"]);
  });
});
