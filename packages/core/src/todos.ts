import { redact, truncate } from "./redact.ts";
import { TODO_LIMITS, type TodoItem, type TodoStatus } from "./schemas.ts";

const STATUS: Record<string, TodoStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  inProgress: "in_progress",
  completed: "completed",
  cancelled: "cancelled",
};

/** Maps a harness's status word to OCD's; unknown words count as pending. */
export function todoStatus(value: unknown): TodoStatus {
  return (typeof value === "string" && STATUS[value]) || "pending";
}

/**
 * Bounds a harness-reported checklist: at most TODO_LIMITS.items single-line,
 * redacted items of TODO_LIMITS.chars characters. Items without text are dropped.
 */
export function boundTodos(items: Iterable<{ text: unknown; status: unknown }>): TodoItem[] {
  const out: TodoItem[] = [];
  for (const item of items) {
    if (out.length >= TODO_LIMITS.items) break;
    if (typeof item.text !== "string") continue;
    const text = truncate(redact(item.text.replace(/\s+/g, " ").trim()), TODO_LIMITS.chars);
    if (text) out.push({ text, status: todoStatus(item.status) });
  }
  return out;
}
