import type { ManagerInfo } from "@ocd/core";

/**
 * The session a message about a task may be sent to: the current one, and only
 * if it is the manager session the supervisor knows. Anything else (a worker,
 * an unrelated session, a non-session screen) must not receive it.
 */
export function managerSessionFor(
  route: { type: string; sessionID?: string },
  manager: ManagerInfo | null,
): string | null {
  if (route.type !== "session" || !route.sessionID) return null;
  return manager?.active?.sessionId === route.sessionID ? route.sessionID : null;
}
