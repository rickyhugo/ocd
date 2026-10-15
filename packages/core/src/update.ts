import type { UpdateStatus } from "./schemas.ts";

// Wording shared by the CLI and the TUI for OCD updating itself.

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "unknown");

/** One line for `ocd status`, or null when there is nothing to say. */
export function updateLine(u: UpdateStatus | null | undefined): string | null {
  if (!u?.enabled) return null;
  if (u.building) return `building ${short(u.building)} (running ${short(u.current)})`;
  if (u.pending) {
    const waiting = u.blockedBy.length
      ? `waiting for ${u.blockedBy.length} worker${u.blockedBy.length === 1 ? "" : "s"} a restart would interrupt`
      : u.cannotApply
        ? `not applied: ${u.cannotApply}`
        : "applying";
    return `${short(u.pending.sha)} ready (running ${short(u.current)}); ${waiting}`;
  }
  if (u.lastError)
    return `running ${short(u.current)}; ${short(u.lastError.sha)} failed: ${u.lastError.message.split("\n")[0]}`;
  return `up to date at ${short(u.current)}${u.checkedAt ? ` (checked ${u.checkedAt})` : ""}`;
}

/** The pending version's changes and what it waits for, for a dialog or the terminal. */
export function describePendingUpdate(u: UpdateStatus): string {
  if (!u.pending) return updateLine(u) ?? "Self-update is off";
  const subjects = u.pending.subjects.slice(0, 15).map((s) => `  • ${s}`);
  return [
    `OCD ${short(u.pending.sha)} is built and smoke-tested (running ${short(u.current)}).`,
    ...(subjects.length ? ["Changes:", ...subjects] : []),
    ...(u.pending.subjects.length > 15 ? [`  … ${u.pending.subjects.length - 15} more`] : []),
    u.blockedBy.length
      ? `It waits for: ${u.blockedBy.map((b) => `${b.title} (${b.harness})`).join(", ")}. Applying now interrupts them; they can be resumed.`
      : u.cannotApply
        ? `Not applied automatically: ${u.cannotApply}.`
        : "It is applied as soon as the supervisor checks again.",
  ].join("\n");
}
