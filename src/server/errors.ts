import type { ErrorCode } from "../shared/api";

/**
 * The only error the HTTP layer knows how to render. Anything else escaping a
 * route becomes a 500 `internal_error`, so an unexpected failure is never
 * mistaken for a rejected request.
 */
export class SquadError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SquadError";
  }
}
