import { blocks, record, type ClaudeStreamMessage } from "./claude-todos.ts";

// A Claude Code turn can end while work it started goes on: a subagent or shell
// started with run_in_background, or a ScheduleWakeup. Claude Code then starts
// the next turn by itself, for the task's completion notice or the wakeup, so
// that turn's result is not the end of the work. All of it is read from the
// stream-json output (2.1.296 to 2.1.301), never from message text.

/** The stream-json fields the tracker reads. */
export interface ClaudeBackgroundMessage extends ClaudeStreamMessage {
  subtype?: string;
  /** system task_started / task_notification. */
  task_id?: unknown;
  is_backgrounded?: unknown;
  /** system background_tasks_changed: every background task still running. */
  tasks?: unknown;
  /** result: turns Claude Code has already queued to run next. */
  queued_turn_count?: unknown;
}

/** Unanswered ScheduleWakeup calls kept at most, so a runaway session stays bounded. */
const MAX_CALLS = 50;

export class ClaudeBackgroundWork {
  private tasks = new Set<string>();
  private readonly wakeupCalls = new Set<string>();
  /** When the armed wakeup fires (epoch ms). */
  private wakeupAt: number | null = null;

  /** Feeds one stream-json message, in stream order. */
  observe(message: ClaudeBackgroundMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "system") this.observeTask(message);
    else if (message.type === "assistant") {
      for (const block of blocks(message)) {
        if (block.type !== "tool_use" || block.name !== "ScheduleWakeup") continue;
        if (typeof block.id !== "string") continue;
        if (this.wakeupCalls.size >= MAX_CALLS) this.wakeupCalls.clear();
        this.wakeupCalls.add(block.id);
      }
    } else if (message.type === "user") {
      for (const block of blocks(message)) {
        if (block.type !== "tool_result" || !this.wakeupCalls.delete(block.tool_use_id ?? ""))
          continue;
        if (block.is_error) continue;
        // ScheduleWakeup's output: when it fires, or 0 when it stopped the loop.
        const at = record(message.tool_use_result)["scheduledFor"];
        this.wakeupAt = typeof at === "number" && at > 0 ? at : null;
      }
    }
  }

  private observeTask(message: ClaudeBackgroundMessage): void {
    const id = message.task_id;
    switch (message.subtype) {
      case "task_started":
        // A foreground task ends inside the turn that started it.
        if (typeof id === "string" && message.is_backgrounded !== false) this.tasks.add(id);
        return;
      case "task_notification":
        if (typeof id === "string") this.tasks.delete(id);
        return;
      case "background_tasks_changed":
        if (Array.isArray(message.tasks))
          this.tasks = new Set(
            message.tasks.flatMap((t) => {
              const taskId = record(t)["task_id"];
              return typeof taskId === "string" ? [taskId] : [];
            }),
          );
        return;
    }
  }

  /** Whether Claude Code starts another turn by itself after this result. */
  continuesAfter(result: ClaudeBackgroundMessage, now: number): boolean {
    const queued = result.queued_turn_count;
    return (
      (typeof queued === "number" && queued > 0) ||
      this.tasks.size > 0 ||
      (this.wakeupAt !== null && this.wakeupAt > now)
    );
  }
}
