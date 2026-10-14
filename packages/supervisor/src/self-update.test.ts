import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createLogger } from "./logger.ts";
import { SelfUpdater, type SelfUpdaterOptions } from "./self-update.ts";
import { makeRepo, rmrf, tempDir } from "./testkit.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

async function waitUntil(ok: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmrf(r);
});

/** OCD's "own" repository with an origin, plus an install dir. */
function world() {
  const root = tempDir("ocd-selfupdate-");
  roots.push(root);
  const repo = makeRepo(root, "ocd");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  const installDir = join(root, "install");
  /** Someone lands a commit on origin/main (optionally adding a migration). */
  const land = (subject: string, migration?: string) => {
    if (migration) {
      mkdirSync(join(repo, "packages/supervisor/drizzle"), { recursive: true });
      writeFileSync(join(repo, "packages/supervisor/drizzle", migration), "-- sql\n");
    }
    writeFileSync(join(repo, "VERSION"), `${subject}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", subject);
    git(repo, "push", "-q", "origin", "main");
    return git(repo, "rev-parse", "HEAD");
  };
  return { root, repo, installDir, land };
}

function updater(
  w: ReturnType<typeof world>,
  overrides: Partial<SelfUpdaterOptions> & { build?: string[] } = {},
) {
  const calls = { restart: 0, notify: [] as string[], smoke: 0, after: 0 };
  const blockers: { taskId: string; title: string; harness: string }[] = [];
  const { build, ...rest } = overrides;
  const u = new SelfUpdater({
    installDir: w.installDir,
    settings: () => ({
      enabled: true,
      repo: "ocd",
      intervalMinutes: 10,
      build: build ?? ["mkdir -p packages/cli/dist && echo built > packages/cli/dist/ocd.mjs"],
    }),
    repoPath: (name) => (name === "ocd" ? w.repo : null),
    blockers: () => blockers,
    notify: (key) => void calls.notify.push(key),
    restart: () => void calls.restart++,
    // Running from the install: the first switch makes this real.
    runningFrom: join(w.installDir, "builds", "seed", "packages/cli/dist/ocd.mjs"),
    logger: createLogger({ level: "silent" } as never),
    smokeTest: async () => void calls.smoke++,
    afterApplied: async () => void calls.after++,
    ...rest,
  });
  return { u, calls, blockers };
}

/** A build the "running" supervisor came from, so switches restart it. */
function seedInstall(w: ReturnType<typeof world>) {
  mkdirSync(join(w.installDir, "builds", "seed", "packages/cli/dist"), { recursive: true });
  writeFileSync(join(w.installDir, "builds", "seed", "packages/cli/dist/ocd.mjs"), "seed\n");
}

describe("self-update", () => {
  it("builds a new commit, smoke-tests it, switches current and restarts; the next start reports it", async () => {
    const w = world();
    seedInstall(w);
    const sha = w.land("feat: something new");
    const { u, calls } = updater(w);

    const s = await u.check();
    expect(calls).toMatchObject({ smoke: 1, restart: 1 });
    expect(s).toMatchObject({ current: sha, pending: null, lastError: null });
    expect(readlinkSync(join(w.installDir, "current"))).toBe(join("builds", sha.slice(0, 12)));
    expect(existsSync(join(w.installDir, "current/packages/cli/dist/ocd.mjs"))).toBe(true);
    // The user's checkout is untouched: still on main, nothing new in it.
    expect(git(w.repo, "status", "--porcelain")).toBe("");

    // The supervisor that starts after the restart says so, once, and reloads OpenCode.
    const next = updater(w);
    next.u.start();
    next.u.stop();
    expect(next.calls.notify).toEqual([`update-applied:${sha}`]);
    await new Promise((r) => setTimeout(r, 10));
    expect(next.calls.after).toBe(1);
    const again = updater(w);
    again.u.start();
    again.u.stop();
    expect(again.calls.notify).toEqual([]);
  });

  it("waits for Claude Code / Codex workers, says so, and applies on force or when they finish", async () => {
    const w = world();
    seedInstall(w);
    const sha = w.land("feat: blocked");
    const { u, calls, blockers } = updater(w);
    blockers.push({ taskId: "t_1", title: "Busy", harness: "claude" });

    const s = await u.check();
    expect(s.pending?.sha).toBe(sha);
    expect(s.pending?.subjects).toContain("feat: blocked");
    expect(s.blockedBy).toEqual(blockers);
    expect(calls.restart).toBe(0);
    expect(calls.notify).toEqual([`update-waiting:${sha}`]);

    await u.tryApply(true);
    expect(calls.restart).toBe(1);
    expect(u.status().current).toBe(sha);
  });

  it("keeps running the current version when a build fails, and does not rebuild the same commit", async () => {
    const w = world();
    seedInstall(w);
    const sha = w.land("feat: broken");
    const { u, calls } = updater(w, { build: ["echo nope >&2; exit 3"] });

    const s = await u.check();
    expect(s).toMatchObject({ current: null, pending: null });
    expect(s.lastError).toMatchObject({ sha });
    expect(s.lastError?.message).toContain("nope");
    expect(calls.notify).toEqual([`update-failed:${sha}`]);
    expect(existsSync(join(w.installDir, "builds", sha.slice(0, 12)))).toBe(false);

    await u.check();
    expect(calls.notify).toHaveLength(1);
    // A fix on origin is picked up.
    const fixed = w.land("fix: build");
    const { u: u2 } = updater(w);
    expect((await u2.check()).current).toBe(fixed);
  });

  it("follows a checkout given by path, without OCD being a declared repository", async () => {
    const w = world();
    seedInstall(w);
    const sha = w.land("feat: from a path");
    const { u, calls } = updater(w, {
      settings: () => ({
        enabled: true,
        repo: "ocd",
        path: w.repo,
        intervalMinutes: 10,
        build: ["mkdir -p packages/cli/dist && echo built > packages/cli/dist/ocd.mjs"],
      }),
      repoPath: () => null,
    });
    expect(await u.check()).toMatchObject({ current: sha, lastError: null });
    expect(calls.restart).toBe(1);

    const { u: missing } = updater(w, {
      settings: () => ({
        enabled: true,
        repo: "ocd",
        path: join(w.root, "nowhere"),
        intervalMinutes: 10,
        build: [],
      }),
    });
    await expect(missing.check()).rejects.toMatchObject({ code: "update_no_repo" });
  });

  it("removes builds older than the previous one when the next supervisor starts", async () => {
    const w = world();
    seedInstall(w);
    const { u } = updater(w);
    const first = w.land("feat: one");
    await u.check();
    const second = w.land("feat: two");
    await u.check();
    // Left behind by a switch whose restart beat its prune.
    mkdirSync(join(w.installDir, "builds", "0123456789ab"));
    writeFileSync(join(w.installDir, "builds", "0123456789ab.log"), "old\n");

    const next = updater(w, {
      runningFrom: join(w.installDir, "builds", second.slice(0, 12), "packages/cli/dist/ocd.mjs"),
    });
    next.u.start();
    next.u.stop();
    const builds = () => readdirSync(join(w.installDir, "builds")).toSorted();
    await waitUntil(() => !builds().includes("0123456789ab"));
    expect(builds()).toEqual(
      [first, second].flatMap((s) => [s.slice(0, 12), `${s.slice(0, 12)}.log`]).toSorted(),
    );
  });

  it("refuses a build whose supervisor does not boot", async () => {
    const w = world();
    seedInstall(w);
    const sha = w.land("feat: crashes on start");
    const { u } = updater(w, {
      smokeTest: async () => {
        throw new Error("did not start: boom");
      },
    });
    const s = await u.check();
    expect(s.lastError).toMatchObject({ sha, message: expect.stringContaining("boom") });
    expect(s.current).toBeNull();
  });

  it("only installs, without restarting, when the service does not run from the install", async () => {
    const w = world();
    const sha = w.land("feat: first install");
    const { u, calls } = updater(w, { runningFrom: join(w.repo, "packages/cli/dist/ocd.mjs") });
    const s = await u.check();
    expect(calls.restart).toBe(0);
    expect(s.current).toBe(sha);
    expect(calls.notify).toEqual([`update-installed:${sha}`]);
    expect(readlinkSync(join(w.installDir, "current"))).toBe(join("builds", sha.slice(0, 12)));
  });

  it("rolls back to the previous version unless the current one added migrations", async () => {
    const w = world();
    seedInstall(w);
    const first = w.land("feat: one");
    const { u } = updater(w);
    await u.check();
    const second = w.land("feat: two");
    await u.check();
    expect(u.status()).toMatchObject({ current: second, previous: first });

    const back = await u.rollback();
    expect(back).toMatchObject({ current: first, previous: second });
    expect(readlinkSync(join(w.installDir, "current"))).toBe(join("builds", first.slice(0, 12)));

    // Forward again, now with a migration the previous version cannot read.
    const third = w.land("feat: three", "0099_new.sql");
    const { u: u2 } = updater(w);
    await u2.check();
    expect(u2.status().current).toBe(third);
    await expect(u2.rollback()).rejects.toMatchObject({ code: "rollback_unsafe" });
  });
});
