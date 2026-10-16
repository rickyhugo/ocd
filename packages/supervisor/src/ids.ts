import { randomBytes } from "node:crypto";

import { systemScheduler } from "@ocd/core";

/** Short, time-sortable identifiers such as `t_mg3k2x9a1b2c3`. */
export function newId(prefix: string): string {
  return `${prefix}_${systemScheduler.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
