import type { Task } from "@ocd/core";
import { describe, expect, it } from "vite-plus/test";

import { LandingService, type LandingOptions } from "./landing.ts";
import { createLogger } from "./logger.ts";
import type { PullRequestHost, PullRequestStatus } from "./pull-requests.ts";

// LandingService against fakes: no database, no git, no gh. The approval gates
// hold at this seam too.

const NOW = Date.parse("2026-10-14T12:00:00Z");

function fakeTask(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add a thing",
    repo: "r",
    harness: "claude",
    model: "m",
    state: "ready_for_review",
    workspaceMode: "isolated",
    workspacePath: "/work/t1",
    branch: "ocd/t1",
    baseRef: "abc",
    pullRequestUrl: null,
    acceptanceCriteria: [],
    ...patch,
  } as Task;
}

function setup(task: Task, pr?: Partial<PullRequestStatus>) {
  const calls = {
    pushCommit: 0,
    merges: [] as unknown[][],
    accept: 0,
    raised: [] as unknown[],
    events: [] as string[],
  };
  const status: PullRequestStatus = {
    state: "open",
    draft: false,
    mergeable: "mergeable",
    mergeState: "CLEAN",
    failingChecks: [],
    pendingChecks: [],
    headSha: "h1",
    ...pr,
  };
  const host: PullRequestHost = {
    create: async () => ({ url: "https://example.test/pr/1" }),
    status: async () => status,
    merge: async (...args) => {
      calls.merges.push(args);
    },
  };
  const store = {
    requireTask: () => task,
    requireRepo: () => ({ path: "/repo" }),
    listTasks: () => [],
    listAttention: () => [],
    raiseAttention: (input: unknown) => {
      calls.raised.push(input);
      return { attention: { id: "a1" }, created: true };
    },
    settleAttention: () => undefined,
    patchTask: () => undefined,
    appendEvent: (_id: string, type: string) => {
      calls.events.push(type);
    },
    enqueue: () => undefined,
  };
  const workspaces = {
    branchFor: () => "ocd/t1",
    defaultBranch: async () => "main",
    fetchBranch: async () => true,
    head: async () => "1234567890abcdef",
    commitsBetween: async () => [{ sha: "1234567", subject: "Add a thing" }],
    filesChangedSince: async () => ["a.ts"],
    verify: async () => ({ dirty: false, commitsAhead: 1, changedFiles: ["a.ts"] }),
    pushCommit: async () => {
      calls.pushCommit += 1;
    },
    landingCommit: async () => "fedcba9876543210",
    remove: async () => undefined,
  };
  const o = {
    store,
    workspaces,
    pullRequests: host,
    live: { mergeMethod: () => "squash" },
    logger: createLogger({ level: "silent" }),
    clock: () => NOW,
    autoCleanup: () => ({ enabled: false, afterHours: 24 }),
    attentionExpiryMinutes: () => 60,
    stopped: () => false,
    withTaskLock: (_id: string, fn: () => Promise<unknown>) => fn(),
    accept: async () => {
      calls.accept += 1;
      task.state = "completed";
      return task;
    },
    acceptLocked: () => task,
    cancel: async () => task,
    releaseWorker: () => undefined,
    tick: () => undefined,
  } as unknown as LandingOptions;
  return { service: new LandingService(o), calls };
}

describe("LandingService", () => {
  it("lets the manager only ask for a direct push; nothing is pushed until a human confirms", async () => {
    const { service, calls } = setup(fakeTask());
    const result = await service.land("t1", { direct: true, commit: false }, "manager");
    expect(result.landed).toBe(false);
    expect(result.attentionId).toBe("a1");
    expect(result.waiting?.code).toBe("confirmation_requested");
    expect(calls.raised).toHaveLength(1);
    expect(calls.pushCommit).toBe(0);
    expect(calls.events).toEqual(["land.requested"]);
  });

  it("refuses a human's direct push without the exact confirmed head", async () => {
    const { service, calls } = setup(fakeTask());
    await expect(
      service.land("t1", { direct: true, commit: false, confirm: "deadbeef" }, "human"),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(calls.pushCommit).toBe(0);
  });

  it("reports a PR with pending checks as what is left and never merges it", async () => {
    const { service, calls } = setup(fakeTask({ state: "completed", pullRequestUrl: "u" }), {
      pendingChecks: ["ci"],
    });
    const result = await service.land("t1", { direct: false, commit: false }, "human");
    expect(result.landed).toBe(false);
    expect(result.waiting?.code).toBe("pr_checks_pending");
    expect(calls.merges).toHaveLength(0);
  });

  it("merges only a mergeable PR whose checks pass, bound to the checked head", async () => {
    const { service, calls } = setup(fakeTask({ state: "completed", pullRequestUrl: "u" }));
    await service.mergePullRequest("t1", {}, "human");
    expect(calls.merges).toEqual([["u", "/repo", "squash", "h1"]]);
  });

  it("lets only a human discard", async () => {
    const { service } = setup(fakeTask());
    await expect(service.discard("t1", undefined, "manager")).rejects.toMatchObject({
      code: "human_only",
    });
  });
});
