import { boundTodos, type TodoItem } from "@ocd/core";

// Claude Code 2.1.296 keeps a worker's checklist with the TaskCreate and
// TaskUpdate tools (TodoWrite when CLAUDE_CODE_ENABLE_TASKS=false). Their calls
// and structured results (`tool_use_result`) arrive on the stream-json output,
// so the checklist is followed from those alone, never from message text.

/** The stream-json fields the tracker reads. */
export interface ClaudeStreamMessage {
  type?: string;
  /** Set on a subagent's messages; only the main agent's checklist is followed. */
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
  tool_use_result?: unknown;
}

export type Block = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
};

const TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
/** Unanswered calls and items kept at most, so a runaway session stays bounded. */
const MAX_CALLS = 50;
const MAX_ITEMS = 200;

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const blocks = (message: ClaudeStreamMessage): Block[] => {
  const content = record(message.message)["content"];
  // Untrusted stream data: skip null and non-object blocks rather than throw.
  return Array.isArray(content)
    ? content.filter((b): b is Block => !!b && typeof b === "object")
    : [];
};

export class ClaudeTodoTracker {
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly items = new Map<string, { text: unknown; status: unknown }>();

  /** Feeds one stream-json message; returns the whole checklist when it changed. */
  observe(message: ClaudeStreamMessage): TodoItem[] | null {
    // Untrusted stream data: anything but an object is not a message.
    if (!message || typeof message !== "object" || message.parent_tool_use_id) return null;
    if (message.type === "assistant") {
      for (const block of blocks(message)) {
        if (
          block.type !== "tool_use" ||
          typeof block.id !== "string" ||
          !TOOLS.has(block.name ?? "")
        )
          continue;
        if (this.calls.size >= MAX_CALLS) this.calls.clear();
        this.calls.set(block.id, { name: block.name!, input: record(block.input) });
      }
      return null;
    }
    if (message.type !== "user") return null;
    const results = blocks(message).filter((b) => b.type === "tool_result");
    let changed = false;
    for (const block of results) {
      const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
      const call = callId ? this.calls.get(callId) : undefined;
      if (!call || !callId) continue;
      this.calls.delete(callId);
      if (block.is_error) continue;
      // The structured result is per message; it is unambiguous with one result.
      const output = results.length === 1 ? record(message.tool_use_result) : {};
      changed = this.apply(call.name, call.input, output) || changed;
    }
    return changed ? boundTodos(this.items.values()) : null;
  }

  private apply(
    name: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
  ): boolean {
    if (name === "TodoWrite") {
      if (!Array.isArray(input["todos"])) return false;
      this.items.clear();
      for (const [i, todo] of (input["todos"] as unknown[]).entries()) {
        if (i >= MAX_ITEMS) break;
        this.items.set(String(i), {
          text: record(todo)["content"],
          status: record(todo)["status"],
        });
      }
      return true;
    }
    if (name === "TaskCreate") {
      const id = record(output["task"])["id"];
      if (typeof id !== "string" || this.items.size >= MAX_ITEMS) return false;
      this.items.set(id, { text: input["subject"], status: "pending" });
      return true;
    }
    // TaskUpdate
    const id = input["taskId"];
    if (typeof id !== "string" || output["success"] === false) return false;
    if (input["status"] === "deleted") return this.items.delete(id);
    const item = this.items.get(id);
    // A task created before OCD started following the session: known only by its subject.
    if (!item) {
      if (typeof input["subject"] !== "string" || this.items.size >= MAX_ITEMS) return false;
      this.items.set(id, { text: input["subject"], status: input["status"] ?? "pending" });
      return true;
    }
    if (input["subject"] !== undefined) item.text = input["subject"];
    if (input["status"] !== undefined) item.status = input["status"];
    return input["subject"] !== undefined || input["status"] !== undefined;
  }
}
