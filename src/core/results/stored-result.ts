import { TRAJECTORY_EVIDENCE_PATH, type Phase } from "../contracts/result.js";
import { classifyError } from "../errors/classify.js";
import { ERROR_CODES, isErrorCode } from "../errors/registry.js";
import { validFailureMetadata } from "../errors/validation.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function phase(value: unknown): value is Phase {
  return typeof value === "string" && ["prepare", "install", "environment", "solve", "transfer", "verify", "collect", "cleanup", "store"].includes(value);
}
function failure(value: unknown): unknown {
  // Read the former automatic-recovery policy without accepting it on new
  // writes or remote uploads. The original file is never rewritten here.
  if (object(value) && value.code === "NETWORK_FAILURE" && value.scope === "attempt" &&
      value.action === "retry_attempt" && value.retryable === true) {
    const current = { ...value, scope: "request", action: "finalize", retryable: false, hint: ERROR_CODES.NETWORK_FAILURE.hint };
    if (validFailureMetadata(current)) return current;
  }
  if (!object(value) || !phase(value.phase) || typeof value.code !== "string" || typeof value.message !== "string" ||
    Object.keys(value).some(key => !["phase", "code", "message"].includes(key))) return value;
  return classifyError(Object.assign(new Error(value.message), { code: value.code }), { phase: value.phase });
}

/** Local disk reads only. Never call this for new commits, imports or wire messages. */
export function upgradeStoredResult(value: unknown): void {
  if (!object(value)) return;
  if ((object(value.key) || value.schemaVersion === 1 && typeof value.runId === "string") && value.evaluationKind === undefined)
    value.evaluationKind = "quality";
  if (object(value.key) && object(value.collection) && typeof value.status === "string") {
    if (!["completed", "error", "timeout", "cancelled", "unsupported", "invalid"].includes(value.status))
      throw new TypeError("Invalid historical attempt status");
    if (value.timeoutKind !== undefined && !(
      value.timeoutKind === "agent" && value.status === "timeout" && value.verdict === null ||
      value.timeoutKind === "infrastructure" && value.status === "invalid"))
      throw new TypeError("Invalid historical timeout attribution");
    const executionStatus = value.status === "completed" ? "completed" : value.status === "cancelled" ? "cancelled"
      : value.status === "timeout" && value.timeoutKind === "agent" && value.evaluationKind !== "performance" ? "agent_timeout" : "failed";
    const scoreStatus = value.evaluationKind === "performance" ? "not-applicable"
      : executionStatus === "completed" || executionStatus === "agent_timeout" ? "valid" : "invalid";
    const fields = ["executionStatus", "scoreStatus", "cleanupStatus"];
    const declared = fields.filter(key => value[key] !== undefined);
    if (declared.length && (declared.length !== fields.length || value.executionStatus !== executionStatus || value.scoreStatus !== scoreStatus))
      throw new TypeError("Inconsistent historical attempt outcome");
    value.executionStatus = executionStatus;
    value.scoreStatus = scoreStatus;
    value.cleanupStatus ??= Array.isArray(value.errors) && value.errors.some(error => object(error) && error.phase === "cleanup") ? "unconfirmed" : "cleaned";
    delete value.status;
    delete value.timeoutKind;
  }
  if (object(value.verdict) && value.verdict.trajectory === TRAJECTORY_EVIDENCE_PATH) {
    if (value.trajectory === undefined) value.trajectory = value.verdict.trajectory;
    delete value.verdict.trajectory;
  }
  if (value.failure !== undefined && value.failure !== null) value.failure = failure(value.failure);
  for (const field of ["errors", "initializationFailures"]) {
    if (Array.isArray(value[field])) value[field] = value[field].map(failure);
  }
  if (Array.isArray(value.warnings)) value.warnings = value.warnings.map(item => {
    if (!object(item) || !phase(item.phase) || typeof item.code !== "string" || typeof item.message !== "string" ||
      Object.keys(item).some(key => !["phase", "code", "message"].includes(key))) return item;
    return { phase: item.phase, code: isErrorCode(item.code) ? item.code : classifyError(Object.assign(new Error(item.message), { code: item.code }), { phase: item.phase }).code,
      message: item.message };
  });
  if (Array.isArray(value.preparationRounds)) for (const round of value.preparationRounds) {
    upgradeStoredResult(round);
    if (object(round) && Array.isArray(round.tasks)) for (const task of round.tasks) upgradeStoredResult(task);
  }
}
