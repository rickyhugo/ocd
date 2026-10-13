import { afterEach, describe, expect, it } from "vite-plus/test";

import { toFtsQuery } from "./memory.ts";
import { setupRepo, startHarness, waitForState, type Harness } from "./testkit.ts";

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe("memory", () => {
  it("confirms explicit human statements and keeps inferred lessons as proposals", async () => {
    h = await startHarness();
    await setupRepo(h, "app");
    await h.human.registerManager({ sessionId: "mgr", directory: h.root });
    const mgr = h.manager("mgr");
    const stated = await mgr.remember({
      scope: "global",
      content: "Prefer small pull requests",
      source: "human",
    });
    const inferred = await mgr.remember({
      scope: "repo",
      repo: "app",
      content: "Integration tests are slow in app",
      source: "manager",
    });
    expect(stated.status).toBe("confirmed");
    expect(stated.recordedBy).toBe("manager");
    expect(inferred.status).toBe("proposed");

    expect(await h.human.recall({ query: "integration tests", repo: "app" })).toEqual([]);
    expect(
      await h.human.recall({ query: "integration tests", repo: "app", includeProposed: true }),
    ).toHaveLength(1);
    await expect(mgr.confirmMemory(inferred.id)).rejects.toMatchObject({ code: "human_only" });
    await h.human.confirmMemory(inferred.id);
    const [hit] = await h.human.recall({ query: "integration tests", repo: "app" });
    expect(hit?.snippet).toContain("[Integration]");
  });

  it("refuses to store secrets", async () => {
    h = await startHarness();
    await expect(
      h.human.remember({
        scope: "global",
        content: "deploy token: ghp_abcdefghijklmnopqrstuvwxyz012345",
        source: "human",
      }),
    ).rejects.toMatchObject({ code: "looks_like_secret" });
  });

  it("keeps repository memory scoped (AT12)", async () => {
    h = await startHarness();
    await setupRepo(h, "alpha");
    await setupRepo(h, "beta");
    await h.human.remember({
      scope: "repo",
      repo: "alpha",
      content: "Alpha uses tabs for indentation",
      source: "human",
    });
    await h.human.remember({
      scope: "global",
      content: "Always write tests for indentation changes",
      source: "human",
    });

    const beta = await h.human.recall({ query: "indentation", repo: "beta", includeGlobal: false });
    expect(beta).toEqual([]);
    const betaWithGlobal = await h.human.recall({ query: "indentation", repo: "beta" });
    expect(betaWithGlobal.map((r) => r.memory.scope)).toEqual(["global"]);
    const globalOnly = await h.human.recall({ query: "indentation" });
    expect(globalOnly.map((r) => r.memory.scope)).toEqual(["global"]);

    // Workers see confirmed memory for their own repository only, never global or other repos.
    const a = await h.human.dispatch({
      repo: "alpha",
      title: "a",
      instructions: "a",
      idempotencyKey: "mem-alpha",
    });
    await waitForState(h, a.task.id, "ready_for_review");
    const b = await h.human.dispatch({
      repo: "beta",
      title: "b",
      instructions: "b",
      idempotencyKey: "mem-beta",
    });
    await waitForState(h, b.task.id, "ready_for_review");
    const prompts = [...h.fakeState.sessions.values()].map((s) => ({
      repo: s.spec.directory,
      prompt: s.prompts[0]!,
    }));
    const alphaPrompt = prompts.find((p) => p.repo.includes("/alpha/"))!.prompt;
    const betaPrompt = prompts.find((p) => p.repo.includes("/beta/"))!.prompt;
    expect(alphaPrompt).toContain("Alpha uses tabs");
    expect(alphaPrompt).not.toContain("Always write tests");
    expect(betaPrompt).not.toContain("Alpha uses tabs");

    // Global briefings never include repository memory.
    const briefing = await h.human.briefing();
    expect(briefing.text).toContain("Always write tests for indentation changes");
    expect(briefing.text).not.toContain("Alpha uses tabs");
  });

  it("supports correction and deletion", async () => {
    h = await startHarness();
    const old = await h.human.remember({
      scope: "global",
      content: "Release on Fridays",
      source: "human",
    });
    const fixed = await h.human.remember({
      scope: "global",
      content: "Release on Tuesdays",
      source: "human",
      supersedes: old.id,
    });
    const hits = await h.human.recall({ query: "release" });
    expect(hits.map((x) => x.memory.id)).toEqual([fixed.id]);
    const all = await h.human.listMemories({});
    expect(all.find((m) => m.id === old.id)).toMatchObject({
      status: "retired",
      supersededBy: fixed.id,
    });

    await h.human.forget(fixed.id);
    expect(await h.human.recall({ query: "release" })).toEqual([]);
    await expect(h.human.forget(fixed.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("builds FTS queries from free text safely", () => {
    expect(toFtsQuery('tabs "OR" NEAR(x)')).toBe('"tabs" OR "OR" OR "NEAR"');
    expect(() => toFtsQuery("?!")).toThrow();
  });
});

describe("cold-start briefing (AT4)", () => {
  it("reconstructs open tasks, pending decisions, and confirmed decisions for a replacement manager", async () => {
    h = await startHarness({ fake: { script: () => [{ type: "hang" }] } });
    await setupRepo(h, "app");
    await h.human.registerManager({ sessionId: "mgr-1", directory: h.root });
    const { task } = await h.manager("mgr-1").dispatch({
      repo: "app",
      title: "Long running work",
      instructions: "x",
      idempotencyKey: "brief-key-1",
    });
    await waitForState(h, task.id, "running");
    await h.manager("mgr-1").recordDecision({ summary: "Ship behind a feature flag", repo: "app" });
    await h
      .manager("mgr-1")
      .remember({ scope: "global", content: "Human prefers terse updates", source: "human" });

    // The old manager session is gone; the human explicitly registers a replacement.
    await h.daemon.stop();
    await h.restart();
    await h.human.registerManager({ sessionId: "mgr-2", directory: h.root, replace: true });
    await expect(h.manager("mgr-1").listTasks()).rejects.toMatchObject({ code: "not_manager" });
    const briefing = await h.manager("mgr-2").briefing();
    expect(briefing.activeTasks.map((t) => t.id)).toContain(task.id);
    expect(briefing.text).toContain("Ship behind a feature flag");
    expect(briefing.text).toContain("Human prefers terse updates");
    expect(briefing.pendingAttention.length).toBeGreaterThan(0); // the interrupted worker needs a decision
    expect(briefing.text.length).toBeLessThanOrEqual(6000);
  });
});
