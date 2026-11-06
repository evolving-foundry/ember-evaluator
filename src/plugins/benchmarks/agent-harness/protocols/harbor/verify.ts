import type { VerificationEvidence } from "../../../../../core/contracts/verifier.js";
import type { VerifyResult } from "../../../../../core/contracts/result.js";
import type { HarborConfig } from "./config.js";

/** Map upstream verifier evidence without implementing a dataset-specific grader. */
export function scoreHarborEvidence(evidence: VerificationEvidence, config: HarborConfig["scoring"]): VerifyResult {
  const details = evidence.details;
  const evaluator = details && typeof details === "object" && !Array.isArray(details) ? details.evaluator : undefined;
  if (evaluator && typeof evaluator === "object" && !Array.isArray(evaluator) &&
      evaluator.kind === "submission-validation-failure" && evaluator.scoreOrigin === "evaluator-failure-fallback") {
    return { score: 0, passed: false, details: { rewards: evidence.rewards, primary: config.primary,
      passThreshold: config.passThreshold, scoring: "submission-failure-zero", evidence: details } };
  }
  const score = evidence.rewards[config.primary];
  if (score === undefined || !Number.isFinite(score)) throw new Error(`Missing finite primary reward: ${config.primary}`);
  if (config.errorValues.includes(score)) throw new Error(`Verifier reported an error sentinel: ${score}`);
  return { score, passed: score >= config.passThreshold, details: { rewards: evidence.rewards,
    primary: config.primary, passThreshold: config.passThreshold, evidence: evidence.details } };
}
