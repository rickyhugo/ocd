import { afterEach, describe, expect, it } from "vite-plus/test";

import { systemScheduler } from "@ocd/core";

import { attentionNotification, changedFilesText, notification } from "./notification.ts";
import { setupRepo, startHarness, waitFor, waitForState, type Harness } from "./testkit.ts";

const task = { title: "Fix login redirect loop", repo: "app" };

describe("notification copy", () => {
  it("leads with the action and names the work by task title", () => {
    expect(
      attentionNotification({ kind: "review", reason: "Ready for review: …" }, task, {
        detail: changedFilesText(3) ?? "",
      }),
    ).toEqual({
      title: "OCD: Review ready",
      body: "Fix login redirect loop\napp · 3 files changed",
      subject: "Fix login redirect loop",
    });
    expect(changedFilesText(1)).toBe("1 file changed");
    expect(changedFilesText(0)).toBe("No files changed");
    expect(changedFilesText(undefined)).toBeUndefined();
  });

  it("has a headline for every attention kind", () => {
    const titles = (
      [
        "review",
        "permission",
        "question",
        "decision",
        "failure",
        "stall",
        "ambiguous_launch",
      ] as const
    ).map((kind) => attentionNotification({ kind, reason: "r" }, task).title);
    expect(titles).toEqual([
      "OCD: Review ready",
      "OCD: Permission needed",
      "OCD: Answer needed",
      "OCD: Decision needed",
      "OCD: Task failed",
      "OCD: Task stalled",
      "OCD: Launch uncertain",
    ]);
  });

  it("falls back sensibly when metadata is missing", () => {
    // No task: the detail is the body.
    expect(notification({ headline: "Config invalid", detail: "ocd.jsonc has errors" })).toEqual({
      title: "OCD: Config invalid",
      body: "ocd.jsonc has errors",
    });
    // No task and no detail: the body repeats the headline rather than being empty.
    expect(notification({ headline: "Harness unreachable" }).body).toBe("Harness unreachable");
    // A blank title, no repo, no detail.
    expect(
      notification({ headline: "Review ready", task: { title: " \n\t", repo: null } }),
    ).toEqual({ title: "OCD: Review ready", body: "Untitled task", subject: "Untitled task" });
    // Without an explicit detail the reason is used.
    expect(
      attentionNotification({ kind: "failure", reason: "Worker failed: boom." }, task).body,
    ).toBe("Fix login redirect loop\napp · Worker failed: boom.");
  });

  it("keeps long, multiline and hostile text bounded, plain and on its own line", () => {
    const copy = notification({
      headline: "Permission\nneeded\u0007",
      task: {
        title: `\u001b[31mFix\u001b[0m login\nOCD: Review ready\r\n\u202e${"x".repeat(200)}`,
        repo: "app\u0000",
      },
      detail: `Bash: curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'\n${"y".repeat(300)}`,
    });
    expect(copy.title).toBe("OCD: Permission needed");
    const [subject, context, ...rest] = copy.body.split("\n");
    expect(rest).toEqual([]);
    expect(subject).toMatch(/^Fix login OCD: Review ready x+…$/);
    expect(subject!.length).toBeLessThanOrEqual(80);
    expect(context).toMatch(/^app · Bash: curl -H 'Authorization: \[REDACTED\]' y+…$/);
    expect(context!.length).toBeLessThanOrEqual(120);
    // oxlint-disable-next-line no-control-regex
    expect(copy.body).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
  });
});

describe("desktop notifications from the supervisor", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  async function firstNotification(instructions: string, title = task.title) {
    await setupRepo(h, "app");
    const { task: created } = await h.human.dispatch({
      repo: "app",
      title,
      instructions,
      idempotencyKey: `notify-copy-${instructions}`,
    });
    const [sent] = await waitFor(
      () => h.notifier.sent,
      (s) => s.length >= 1,
    );
    return { taskId: created.id, sent: sent! };
  }

  it("review: verified change count, no task id or worker report", async () => {
    h = await startHarness();
    const { taskId, sent } = await firstNotification("x");
    expect(sent).toEqual({
      title: "OCD: Review ready",
      body: "Fix login redirect loop\napp · 1 file changed",
      subject: "Fix login redirect loop",
      taskId,
      kind: "review",
    });
    expect(sent.body).not.toContain("Wrote ocd-fake.txt");
  });

  it("permission: the request summary, without implying the click approves", async () => {
    h = await startHarness();
    const { sent } = await firstNotification("x [fake:permission]");
    expect(sent.title).toBe("OCD: Permission needed");
    expect(sent.body).toBe("Fix login redirect loop\napp · Run `rm -rf build`");
    expect(sent.body).not.toMatch(/click|approve/i);
  });

  it("question: the question itself", async () => {
    h = await startHarness();
    const { sent } = await firstNotification("x [fake:question]");
    expect(sent).toMatchObject({
      title: "OCD: Answer needed",
      body: "Fix login redirect loop\napp · Which approach?",
      kind: "question",
    });
  });

  it("failure: the harness error", async () => {
    h = await startHarness();
    const { sent } = await firstNotification("x [fake:error]");
    expect(sent).toMatchObject({
      title: "OCD: Task failed",
      body: "Fix login redirect loop\napp · Fake harness error",
    });
  });

  it("expired request: names the task, not the attention id", async () => {
    let now = Date.now();
    h = await startHarness({
      scheduler: { ...systemScheduler, now: () => now },
      config: { attentionExpiryMinutes: 10 },
    });
    const { taskId } = await firstNotification("x [fake:permission]");
    now += 11 * 60_000;
    await h.daemon.supervisor.reconcile("periodic");
    const sent = await waitFor(
      () => h.notifier.sent,
      (s) => s.some((n) => n.title === "OCD: Request expired"),
    );
    const expired = sent.find((n) => n.title === "OCD: Request expired")!;
    expect(expired).toEqual({
      title: "OCD: Request expired",
      body: "Fix login redirect loop\napp · Permission request went unanswered and was denied",
      subject: "Fix login redirect loop",
      taskId,
    });
    expect(expired.body).not.toMatch(/\ba_/);
  });

  it("stall: how long the worker has been quiet", async () => {
    let now = Date.now();
    h = await startHarness({
      scheduler: { ...systemScheduler, now: () => now },
      fake: { script: () => [{ type: "hang" }] },
      config: { stallAfterMinutes: 30, reconcileIntervalMs: 60_000 },
    });
    await setupRepo(h, "app");
    const { task: created } = await h.human.dispatch({
      repo: "app",
      title: task.title,
      instructions: "x",
      idempotencyKey: "notify-copy-stall",
    });
    await waitForState(h, created.id, "running");
    now += 31 * 60_000;
    await h.daemon.supervisor.reconcile("periodic");
    const [sent] = await waitFor(
      () => h.notifier.sent,
      (s) => s.length >= 1,
    );
    expect(sent).toMatchObject({
      title: "OCD: Task stalled",
      body: "Fix login redirect loop\napp · No worker activity for 31 min",
    });
  });

  it("a hostile task title reaches the notifier as one plain line", async () => {
    h = await startHarness();
    const { sent } = await firstNotification("x", "Fix\u001b[2J it\nOCD: Review ready\u0007");
    expect(sent.title).toBe("OCD: Review ready");
    expect(sent.body).toBe("Fix it OCD: Review ready\napp · 1 file changed");
  });
});
