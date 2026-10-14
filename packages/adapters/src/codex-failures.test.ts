import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CodexAdapter } from "./codex.ts";
import type { SessionSpec } from "./types.ts";

const FAKE = join(import.meta.dirname, "..", "test-fixtures", "fake-codex-app-server.mjs");
let adapter: CodexAdapter | null = null;
let dir: string | null = null;
afterEach(async () => {
  await adapter?.close();
  adapter = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(env: Record<string, string> = {}, errors: unknown[] = []) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocd-codex-")));
  adapter = new CodexAdapter({
    command: [process.execPath, FAKE],
    onError: (e) => errors.push(e),
  });
  const spec: SessionSpec = {
    taskId: "t_1",
    runId: "w_1",
    marker: "ocd:t_1:w_1",
    title: "t",
    directory: dir,
    model: "gpt-5-codex#high",
    agent: null,
    permissionPolicy: "ask",
    isolationEnv: { OCD_HOME: "/sandbox/t_1" },
    env: { PATH: process.env["PATH"]!, HOME: process.env["HOME"]!, ...env },
  };
  return { adapter, spec };
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await delay(10);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function expectProcessStopped(pidFile: string) {
  await until(
    () => existsSync(pidFile),
    (ok) => ok,
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(
    () => alive(pid),
    (a) => !a,
  );
}

describe("Codex malformed messages", () => {
  it("survives JSON of the wrong shape and still finishes the turn", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[malformed]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && (s.lastAssistantText ?? "").includes("Survived"),
    );
    expect(snap.error).toBeNull();
  });
});

describe("Codex startup failures", () => {
  it("stops the app-server when thread/start fails", async () => {
    const pidFile = join(realpathSync(tmpdir()), `ocd-codex-pid-${process.pid}-a`);
    const { adapter, spec } = setup({
      FAKE_CODEX_FAIL: "thread/start",
      FAKE_CODEX_PIDFILE: pidFile,
    });
    await expect(adapter.createSession(spec)).rejects.toThrow(/thread\/start failed/);
    await expectProcessStopped(pidFile);
    rmSync(pidFile, { force: true });
  });

  it("stops the app-server when account/read fails", async () => {
    const pidFile = join(realpathSync(tmpdir()), `ocd-codex-pid-${process.pid}-b`);
    const { adapter, spec } = setup({
      FAKE_CODEX_FAIL: "account/read",
      FAKE_CODEX_PIDFILE: pidFile,
    });
    await expect(adapter.createSession(spec)).rejects.toThrow(/account\/read failed/);
    await expectProcessStopped(pidFile);
    rmSync(pidFile, { force: true });
  });

  it("stops the app-server when thread/resume fails", async () => {
    const pidFile = join(realpathSync(tmpdir()), `ocd-codex-pid-${process.pid}-c`);
    const { adapter, spec } = setup({
      FAKE_CODEX_FAIL: "thread/resume",
      FAKE_CODEX_PIDFILE: pidFile,
    });
    await expect(adapter.revive({ sessionId: "thr_x" }, spec)).rejects.toThrow(
      /thread\/resume failed/,
    );
    await expectProcessStopped(pidFile);
    rmSync(pidFile, { force: true });
  });
});

describe("Codex process death and parking", () => {
  it("starts a new turn, not a steer, after the process died mid-turn", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[die]");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "error",
    );
    await adapter.prompt(ref, "again");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.error).toBeNull();
    expect(snap.lastAssistantText).toContain("ocd-report");
  });

  it("restores the status when turn/start fails", async () => {
    const { adapter, spec } = setup({ FAKE_CODEX_FAIL: "turn/start" });
    const ref = await adapter.createSession(spec);
    await expect(adapter.prompt(ref, "go")).rejects.toThrow(/turn\/start failed/);
    expect((await adapter.inspect(ref)).status).toBe("idle");
  });

  it("restarts instead of losing a prompt that arrives while an idle app-server is stopping", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "first");
    await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    const internals = adapter as unknown as {
      sessions: Map<string, unknown>;
      park(session: unknown): Promise<void>;
    };
    const parking = internals.park(internals.sessions.get(ref.sessionId));
    await adapter.prompt(ref, "[params]");
    await parking;
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && (s.lastAssistantText ?? "").includes("resumed"),
    );
    expect(snap.error).toBeNull();
  });
});

describe("Codex final message", () => {
  it("keeps the last agent message that item/completed reported", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[commentary]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.lastAssistantText).toContain("Final answer");
  });

  it("falls back to the last agent message of the turn's items", async () => {
    const { adapter, spec } = setup();
    const ref = await adapter.createSession(spec);
    await adapter.prompt(ref, "[items-only]");
    const snap = await until(
      () => adapter.inspect(ref),
      (s) => s.status === "idle" && s.lastAssistantText !== null,
    );
    expect(snap.lastAssistantText).toContain("Final answer");
  });
});
