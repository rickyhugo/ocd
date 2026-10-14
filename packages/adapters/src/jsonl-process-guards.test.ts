import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { JsonLineProcess } from "./jsonl-process.ts";

const env = { PATH: process.env["PATH"]! };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("JsonLineProcess guards", () => {
  it("does not throw on valid JSON of the wrong shape or a throwing handler", async () => {
    const script = `
      for (const line of ["null", "7", "[1]", '"s"', '{"boom":true}', '{"ok":1}'])
        console.log(line);
    `;
    const messages: unknown[] = [];
    const invalid: string[] = [];
    const errors: unknown[] = [];
    const proc = new JsonLineProcess(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env,
      onMessage: (m) => {
        if ((m as { boom?: boolean }).boom) throw new Error("handler bug");
        messages.push(m);
      },
      onInvalidLine: (l) => invalid.push(l),
      onError: (e) => errors.push(e),
    });
    await proc.exited;
    await delay(50);
    expect(messages).toEqual([{ ok: 1 }]);
    expect(invalid).toEqual(["null", "7", "[1]", '"s"']);
    expect(errors).toHaveLength(1);
  });

  it("kills the whole process group when the child ignores shutdown", async () => {
    // The child ignores SIGTERM and stdin close, and leaves a grandchild behind.
    const script = `
      process.on("SIGTERM", () => {});
      const gc = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(JSON.stringify({ gc: gc.pid }));
      setInterval(() => {}, 1000);
    `;
    let grandchild = 0;
    const proc = new JsonLineProcess(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      env,
      onMessage: (m) => (grandchild = (m as { gc: number }).gc),
    });
    for (let i = 0; i < 300 && !grandchild; i += 1) await delay(10);
    expect(alive(grandchild)).toBe(true);
    await proc.stop(200);
    for (let i = 0; i < 300 && alive(grandchild); i += 1) await delay(10);
    expect(alive(grandchild)).toBe(false);
  });

  it("refuses to send after stdin was closed", async () => {
    const proc = new JsonLineProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env,
      onMessage: () => undefined,
    });
    const stopping = proc.stop(200);
    expect(() => proc.send({})).toThrow(/not running/);
    await stopping;
  });
});
