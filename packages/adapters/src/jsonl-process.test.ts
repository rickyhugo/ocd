import { describe, expect, it } from "vite-plus/test";

import { JsonLineProcess } from "./jsonl-process.ts";

const ECHO = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.log(JSON.stringify({ hello: process.env.ONLY_THIS ?? null, leaked: process.env.SECRET_TOKEN ?? null }));
console.log("not json");
rl.on("line", (l) => console.log(JSON.stringify({ echo: JSON.parse(l) })));
`;

describe("JsonLineProcess", () => {
  it("frames JSON lines, passes only the given env, and stops cleanly", async () => {
    const messages: unknown[] = [];
    const invalid: string[] = [];
    process.env["SECRET_TOKEN"] = "should-not-leak";
    const proc = new JsonLineProcess(process.execPath, ["-e", ECHO], {
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"]!, ONLY_THIS: "yes" },
      onMessage: (m) => messages.push(m),
      onInvalidLine: (l) => invalid.push(l),
    });
    proc.send({ n: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(messages).toEqual([{ hello: "yes", leaked: null }, { echo: { n: 1 } }]);
    expect(invalid).toEqual(["not json"]);
    await proc.stop();
    expect(proc.running).toBe(false);
    expect(() => proc.send({})).toThrow(/not running/);
    delete process.env["SECRET_TOKEN"];
  });

  it("reports a missing binary as an exit", async () => {
    const proc = new JsonLineProcess("/nonexistent/claude", [], {
      cwd: process.cwd(),
      env: {},
      onMessage: () => undefined,
    });
    expect((await proc.exited).code).toBeNull();
    expect(proc.stderr()).toMatch(/ENOENT/);
  });
});
