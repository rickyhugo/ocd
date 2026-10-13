import { randomBytes } from "node:crypto";

/** Short, time-sortable identifiers such as `t_mg3k2x9a1b2c3`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
