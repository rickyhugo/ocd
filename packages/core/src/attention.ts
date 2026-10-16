import type { AttentionResponse } from "./schemas.ts";

// Attention kinds: why an attention item exists, and what follows from that.
// Kinds are persisted and on the wire, so renaming one orphans stored rows.

export interface AttentionKindSpec {
  /** Stops the task's work until someone answers. */
  blocking: boolean;
  /** A live harness request, answered through the worker's session. */
  interaction: boolean;
  /**
   * "any": one item per dedupe key, ever (requests tied to one harness request
   * or window); "open": per-turn outcomes, raised again once the previous one
   * is settled.
   */
  dedupe: "any" | "open";
  responses: readonly AttentionResponse["type"][];
  /** Resuming the task answers it. */
  settledByResume: boolean;
  /** Short name in the sidebar and spill. */
  label: string;
}

const ANY_RESPONSE = ["approve", "deny", "answer", "acknowledge"] as const;

const kinds = {
  decision: {
    blocking: true,
    interaction: false,
    dedupe: "open",
    responses: ANY_RESPONSE,
    settledByResume: true,
    label: "decision",
  },
  permission: {
    blocking: true,
    interaction: true,
    dedupe: "any",
    responses: ["approve", "deny"],
    settledByResume: false,
    label: "permission",
  },
  question: {
    blocking: true,
    interaction: true,
    dedupe: "any",
    responses: ["answer", "deny"],
    settledByResume: false,
    label: "question",
  },
  failure: {
    blocking: false,
    interaction: false,
    dedupe: "open",
    responses: ANY_RESPONSE,
    settledByResume: true,
    label: "failure",
  },
  stall: {
    blocking: false,
    interaction: false,
    dedupe: "any",
    responses: ANY_RESPONSE,
    settledByResume: true,
    label: "stalled",
  },
  review: {
    blocking: false,
    interaction: false,
    dedupe: "open",
    responses: ANY_RESPONSE,
    settledByResume: false,
    label: "review",
  },
  ambiguous_launch: {
    blocking: true,
    interaction: false,
    dedupe: "any",
    responses: ANY_RESPONSE,
    settledByResume: true,
    label: "unclear launch",
  },
  land: {
    blocking: true,
    interaction: false,
    dedupe: "open",
    responses: ["approve", "deny"],
    settledByResume: false,
    label: "confirm push",
  },
} satisfies Record<string, AttentionKindSpec>;

type Kind = keyof typeof kinds;

export const ATTENTION_KINDS: Readonly<Record<Kind, AttentionKindSpec>> = kinds;

export const ATTENTION_KIND_NAMES = Object.keys(kinds) as [Kind, ...Kind[]];
