import type { AttemptRecord } from "../contracts/result.js";
import { identifyNetworkFailure } from "../errors/network-failure.js";
import { isManualRetryEligible } from "./manual-retry.js";

export const MAX_STREAM_TASK_RETRIES = 2;

/** Retry the whole task only after a failed model stream and confirmed cleanup. */
export function isStreamTaskRetryEligible(record: AttemptRecord): boolean {
  return isManualRetryEligible(record) && record.errors.every(failure => failure.phase === "solve" &&
    identifyNetworkFailure([failure, ...(failure.causes ?? [])], { phase: failure.phase })?.networkReason === "response-truncated");
}
