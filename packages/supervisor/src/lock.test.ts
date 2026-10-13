import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { LockHeldError, SupervisorLock } from "./lock.ts";
import { rmrf, tempDir } from "./testkit.ts";

describe("singleton lock", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(rmrf));

  it("admits exactly one holder and frees on release", () => {
    const dir = tempDir();
    dirs.push(dir);
    const path = join(dir, "supervisor.lock");
    const first = SupervisorLock.acquire(path, { pid: 1, instanceId: "a" });
    expect(() => SupervisorLock.acquire(path, { pid: 2, instanceId: "b" })).toThrow(LockHeldError);
    first.release();
    const second = SupervisorLock.acquire(path, { pid: 3, instanceId: "c" });
    second.release();
  });
});
