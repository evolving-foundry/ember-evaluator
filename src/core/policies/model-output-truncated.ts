import type { ErrorCode } from "../errors/registry.js";
export const SOLVER_OUTPUT_LIMIT_CODE = "SOLVER_OUTPUT_LIMIT";

export type ModelOutputTruncationReason = "recovery-exhausted" | "iteration-budget-exhausted";

/** A solver exhausted its bounded recovery for an explicitly truncated empty response. */
export class ModelOutputTruncatedError extends Error {
  readonly code: ErrorCode = SOLVER_OUTPUT_LIMIT_CODE;
  readonly phase = "solve";

  constructor(readonly reason: ModelOutputTruncationReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelOutputTruncatedError";
  }
}
