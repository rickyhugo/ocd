import type { ErrorCode } from "@ocd/core";

/** A failure reported to clients by its stable code; api.ts picks the HTTP status. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "DomainError";
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found`);

/** Thrown by crash hooks in tests to stop a supervisor mid-operation without cleanup. */
export class SimulatedCrash extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`Simulated supervisor crash at ${point}`);
    this.point = point;
    this.name = "SimulatedCrash";
  }
}
