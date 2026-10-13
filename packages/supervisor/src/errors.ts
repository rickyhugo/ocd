/** An error with an HTTP status and stable code, surfaced through the API. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "ApiError";
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);

/** Thrown by crash hooks in tests to stop a supervisor mid-operation without cleanup. */
export class SimulatedCrash extends Error {
  readonly point: string;

  constructor(point: string) {
    super(`Simulated supervisor crash at ${point}`);
    this.point = point;
    this.name = "SimulatedCrash";
  }
}
