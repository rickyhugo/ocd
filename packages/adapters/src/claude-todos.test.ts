import { describe, expect, it } from "vite-plus/test";

import { ClaudeTodoTracker, type ClaudeStreamMessage } from "./claude-todos.ts";

const use = (id: string, name: string, input: unknown, parent: string | null = null) =>
  ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name, input }] },
  }) satisfies ClaudeStreamMessage;

const result = (id: string, output: unknown, extra: Record<string, unknown> = {}) =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] },
    tool_use_result: output,
  }) satisfies ClaudeStreamMessage;

function run(tracker: ClaudeTodoTracker, messages: ClaudeStreamMessage[]) {
  let last = null;
  for (const m of messages) last = tracker.observe(m) ?? last;
  return last;
}

describe("Claude checklist tracking", () => {
  it("follows TaskCreate and TaskUpdate through their structured results", () => {
    const tracker = new ClaudeTodoTracker();
    expect(tracker.observe(use("a", "TaskCreate", { subject: "Read" }))).toBeNull();
    expect(tracker.observe(result("a", { task: { id: "1", subject: "Read" } }))).toEqual([
      { text: "Read", status: "pending" },
    ]);
    expect(
      run(tracker, [
        use("b", "TaskCreate", { subject: "Write" }),
        result("b", { task: { id: "2", subject: "Write" } }),
        use("c", "TaskUpdate", { taskId: "1", status: "completed" }),
        result("c", { success: true, taskId: "1", updatedFields: ["status"] }),
        use("d", "TaskUpdate", { taskId: "2", status: "in_progress", subject: "Write it" }),
        result("d", { success: true, taskId: "2", updatedFields: ["status", "subject"] }),
      ]),
    ).toEqual([
      { text: "Read", status: "completed" },
      { text: "Write it", status: "in_progress" },
    ]);
    expect(
      run(tracker, [
        use("e", "TaskUpdate", { taskId: "1", status: "deleted" }),
        result("e", { success: true, taskId: "1", updatedFields: ["status"] }),
      ]),
    ).toEqual([{ text: "Write it", status: "in_progress" }]);
  });

  it("follows TodoWrite as a whole-list replacement", () => {
    const tracker = new ClaudeTodoTracker();
    const todos = [
      { content: "One", status: "completed", activeForm: "Doing one" },
      { content: "Two", status: "in_progress", activeForm: "Doing two" },
    ];
    expect(run(tracker, [use("a", "TodoWrite", { todos }), result("a", {})])).toEqual([
      { text: "One", status: "completed" },
      { text: "Two", status: "in_progress" },
    ]);
  });

  it("ignores failed calls, subagents, other tools and unknown tasks", () => {
    const tracker = new ClaudeTodoTracker();
    expect(
      run(tracker, [
        use("a", "TaskCreate", { subject: "Errored" }),
        result("a", { task: { id: "1" } }, { is_error: true }),
        use("b", "TaskCreate", { subject: "Subagent" }, "toolu_parent"),
        result("b", { task: { id: "2" } }),
        use("c", "Bash", { command: "ls" }),
        result("c", { stdout: "x" }),
        use("d", "TaskUpdate", { taskId: "7", status: "completed" }),
        result("d", { success: true }),
        use("e", "TaskUpdate", { taskId: "8", status: "completed" }),
        result("e", { success: false, error: "no such task" }),
      ]),
    ).toBeNull();
  });

  it("skips malformed content blocks instead of throwing", () => {
    const tracker = new ClaudeTodoTracker();
    const malformed = (type: string, content: unknown) =>
      ({ type, parent_tool_use_id: null, message: { content } }) satisfies ClaudeStreamMessage;
    expect(
      run(tracker, [
        malformed("assistant", [null, 5, "text", { type: 5 }]),
        malformed("assistant", "not-an-array"),
        malformed("user", [null, { type: "tool_result" }]),
        use("a", "TaskCreate", { subject: "Read" }),
        result("a", { task: { id: "1" } }),
      ]),
    ).toEqual([{ text: "Read", status: "pending" }]);
  });

  it("bounds and redacts what it reports", () => {
    const tracker = new ClaudeTodoTracker();
    const todos = Array.from({ length: 80 }, (_, i) => ({
      content: i === 0 ? `Use token=supersecretvalue and ${"x".repeat(400)}` : `Step ${i}`,
      status: "pending",
    }));
    const out = run(tracker, [use("a", "TodoWrite", { todos }), result("a", {})])!;
    expect(out).toHaveLength(50);
    expect(out[0]!.text).not.toContain("supersecretvalue");
    expect(out[0]!.text.length).toBeLessThanOrEqual(200);
  });
});
