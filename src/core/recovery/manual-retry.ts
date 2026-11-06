import type { AttemptRecord } from "../contracts/result.js";
import { identifyNetworkFailure } from "../errors/network-failure.js";
import { isEvaluationComplete, hasUnconfirmedCleanup } from "../results/evaluation-outcome.js";

/** Shared safety checks for network reruns; automatic recovery adds stricter evidence checks. */
export function isManualRetryEligible(record: AttemptRecord): boolean {
  return record.verdict === null && !isEvaluationComplete(record) && !hasUnconfirmedCleanup(record) &&
    record.executionStatus !== "cancelled" && record.errors.some(failure => failure.code === "NETWORK_FAILURE" &&
      identifyNetworkFailure([{ code: failure.code, message: failure.message, details: failure.details }, ...(failure.causes ?? [])], { phase: failure.phase }) !== null) &&
    record.errors.every(failure => failure.code === "NETWORK_FAILURE");
}
