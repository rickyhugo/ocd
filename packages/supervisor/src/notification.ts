import { plainText, redact, truncate, type AttentionKind } from "@ocd/core";

// Copy for desktop notifications. The title says what happened or what is
// needed; the body names the work by its task title, then one short factual
// line. Everything comes from task metadata, supervisor-written reasons and
// harness-reported facts (request summaries, errors); nothing is summarized or
// inferred. Worker reports stay out: they are long and untrusted.

/** Desktop copy supplied where an attention item is raised. */
export interface Notice {
  /** Action-first status, e.g. "Task failed". Defaults by attention kind. */
  headline?: string;
  /** One short factual line, e.g. the failing error. Defaults to the reason. */
  detail?: string;
}

export interface NotificationCopy {
  title: string;
  body: string;
  /** The task's title as shown in the body, for grouping several notifications. */
  subject?: string;
}

const HEADLINES: Record<AttentionKind, string> = {
  review: "Review ready",
  permission: "Permission needed",
  question: "Answer needed",
  decision: "Decision needed",
  failure: "Task failed",
  stall: "Task stalled",
  ambiguous_launch: "Launch uncertain",
};

const HEADLINE_MAX = 40;
const SUBJECT_MAX = 80;
const DETAIL_MAX = 120;
const UNTITLED = "Untitled task";

/** One display line: no control characters or secrets, bounded length. */
export function noticeLine(text: string, max: number): string {
  return truncate(redact(plainText(text)), max);
}

export function notification(input: {
  headline: string;
  task?: { title: string; repo: string | null } | null;
  detail?: string | null | undefined;
}): NotificationCopy {
  const headline = noticeLine(input.headline, HEADLINE_MAX) || "Update";
  const detail = input.detail ? noticeLine(input.detail, DETAIL_MAX) : "";
  if (!input.task) return { title: `OCD: ${headline}`, body: detail || headline };
  const subject = noticeLine(input.task.title, SUBJECT_MAX) || UNTITLED;
  const repo = input.task.repo ? noticeLine(input.task.repo, 40) : "";
  const context = truncate([repo, detail].filter(Boolean).join(" · "), DETAIL_MAX);
  return {
    title: `OCD: ${headline}`,
    body: context ? `${subject}\n${context}` : subject,
    subject,
  };
}

/** Verified change count for a review notification; undefined when nothing was verified. */
export function changedFilesText(count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return "No files changed";
  return `${count} ${count === 1 ? "file" : "files"} changed`;
}

/** Copy for a newly raised attention item, with defaults from its kind and reason. */
export function attentionNotification(
  attention: { kind: AttentionKind; reason: string },
  task: { title: string; repo: string | null } | null,
  notice: Notice = {},
): NotificationCopy {
  return notification({
    headline: notice.headline ?? HEADLINES[attention.kind],
    task,
    detail: notice.detail ?? attention.reason,
  });
}
