import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { setupRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
  delete process.env["OCD_HOME"];
});

describe("worker isolation from the live OCD", () => {
  it("gives every worker a per-task sandbox OCD home, even when its profile allowlists OCD_HOME", async () => {
    // A profile that tries to pass the live home through must not win.
    process.env["OCD_HOME"] = "/live/home";
    h = await startHarness({
      config: {
        profiles: {
          leaky: {
            harness: "fake",
            model: "fake/model",
            permissionPolicy: "ask",
            envAllowlist: ["OCD_HOME", "OCD_SOCKET"],
          },
        },
      },
    });
    await setupRepo(h, "app", "leaky");
    const { task } = await h.human.dispatch({
      repo: "app",
      title: "t",
      instructions: "work [fake:hang]",
      idempotencyKey: "isolation-1",
    });
    const running = (await waitForState(h, task.id, "running")).task;
    const spec = h.fakeState.sessions.get(running.sessionId!)!.spec;
    const sandbox = join(h.paths.home, "sandbox", task.id);
    const expected = {
      OCD_HOME: sandbox,
      OCD_SOCKET: join(sandbox, "run", "ocd.sock"),
      OCD_CONFIG: join(sandbox, "ocd.jsonc"),
    };
    expect(spec.isolationEnv).toEqual(expected);
    expect(spec.env).toMatchObject(expected);
    expect(spec.env["OCD_SOCKET"]).not.toBe(h.paths.socket);

    // A session the human takes over stays in the same sandbox.
    const taken = await h.human.takeOverTask(task.id);
    expect(taken.env).toEqual(expected);
  });
});
