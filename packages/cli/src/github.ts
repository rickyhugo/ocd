import type { GitHubCliStatus } from "@ocd/core";

/** One line for `ocd status` / `ocd doctor`. */
export function describeGh(status: GitHubCliStatus): string {
  if (!status.available) return `UNAVAILABLE ${status.problems.join("; ")}`;
  const auth =
    status.auth === "ok"
      ? "logged in"
      : status.auth === "unknown"
        ? "login not verified"
        : `login ${status.auth}`;
  return [`ok ${status.version ?? ""} ${status.path}, ${auth}`, ...status.problems].join("; ");
}
