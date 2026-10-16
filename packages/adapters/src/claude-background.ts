import { blocks, record, type ClaudeStreamMessage } from "./claude-todos.ts";

// A Claude Code turn can end (its `result`) while work it started goes on: a
// subagent or shell started with run_in_background, a completion notice not yet
// delivered, or a ScheduleWakeup. Claude Code then starts the next turn by
// itself, so that `result` is not the end of the work. With
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS set it reports `session_state_changed`
// "idle" only once its own wait for background agents and their notices is
// over, which its schema calls the authoritative turn-over signal. A pending
// wakeup does not hold that state, so it is followed from ScheduleWakeup's
// structured output. Read from the 2.1.296 to 2.1.301 builds, never from
// message text.

export const SESSION_STATE_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" };

/** The stream-json fields the tracker reads. */
export interface ClaudeBackgroundMessage extends ClaudeStreamMessage {
  subtype?: string;
  /** system session_state_changed. */
  state?: unknown;
}

export class ClaudeBackgroundWork {
  /** Claude Code's own session state; null until this process reports one. */
  private state: string | null = null;
  private readonly wakeupCalls = new Set<string>();
  /** When the armed wakeup fires (epoch ms). */
  private wakeupAt: number | null = null;

  /** Feeds one stream-json message, in stream order. */
  observe(message: ClaudeBackgroundMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.type === "system" && message.subtype === "session_state_changed") {
      if (typeof message.state === "string") this.state = message.state;
    } else if (message.type === "assistant") {
      for (const block of blocks(message)) {
        if (block.type === "tool_use" && block.name === "ScheduleWakeup" && block.id)
          this.wakeupCalls.add(block.id);
      }
    } else if (message.type === "user") {
      for (const block of blocks(message)) {
        if (block.type !== "tool_result" || !this.wakeupCalls.delete(block.tool_use_id ?? ""))
          continue;
        if (block.is_error) continue;
        // When it fires, or 0 when the call stopped the loop.
        const at = record(message.tool_use_result)["scheduledFor"];
        this.wakeupAt = typeof at === "number" && at > 0 ? at : null;
      }
    }
  }

  /** Whether Claude Code will start another turn by itself. */
  continues(now: number): boolean {
    return (
      (this.state !== null && this.state !== "idle") ||
      (this.wakeupAt !== null && this.wakeupAt > now)
    );
  }
}
