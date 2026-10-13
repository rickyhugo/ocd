import type { Task } from "@ocd/core";

/** Finds tasks by full id, id suffix, or words that all appear in title, repo or id. */
export function matchTasks<T extends Pick<Task, "id" | "title" | "repo">>(
  tasks: T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return tasks;
  const exact = tasks.filter((t) => t.id === trimmed || t.id.endsWith(trimmed));
  if (exact.length > 0) return exact;
  const words = trimmed.toLowerCase().split(/\s+/);
  return tasks.filter((t) =>
    words.every((w) => `${t.title} ${t.repo} ${t.id}`.toLowerCase().includes(w)),
  );
}
