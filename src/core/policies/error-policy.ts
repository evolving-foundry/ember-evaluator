import type { AttemptRecord, Failure } from "../contracts/result.js";
import type { ErrorAction } from "../contracts/errors.js";
import { normalizeFailure } from "../errors/classify.js";
import { ERROR_CODES } from "../errors/registry.js";

export function failureDecision(failure: Failure): { action: ErrorAction; retryable: false } {
  const normalized = normalizeFailure(failure);
  return { action: ERROR_CODES[normalized.code].action, retryable: false };
}

export function requiresDispatchStop(record: AttemptRecord): boolean {
  return record.errors.some(failure => ["abort_run", "stop_dispatch"].includes(failureDecision(failure).action));
}
