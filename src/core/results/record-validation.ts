import { TRAJECTORY_EVIDENCE_PATH, type AttemptKey, type AttemptRecord, type SolveResult, type VerifyResult } from "../contracts/result.js";
import { assertEvaluationVerdict } from "./evaluation-outcome.js";
import { isErrorCode } from "../errors/registry.js";
import { validFailureMetadata } from "../errors/validation.js";

const phases = new Set(["prepare", "install", "environment", "solve", "transfer", "verify", "collect", "cleanup", "store"]);
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function text(value: unknown): value is string {
  return typeof value === "string";
}
function elapsed(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function tokenCount(value: unknown): boolean {
  return value === null || (elapsed(value) && Number.isSafeInteger(value));
}
function timestamp(value: unknown): boolean {
  return text(value) && Number.isFinite(Date.parse(value));
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || text(value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return object(value) && Object.values(value).every(jsonValue);
}
function invalid(field: string): never {
  throw new TypeError(`STORE_RECORD_INVALID: malformed ${field}`);
}
function failedCheck(value: unknown): boolean {
  if (!object(value) || !text(value.name) || value.name.trim() === "") return false;
  if (Object.keys(value).some(key => key !== "name" && key !== "group" && key !== "detail")) return false;
  if (value.group !== undefined && (!text(value.group) || value.group.trim() === "")) return false;
  if (value.detail !== undefined && !text(value.detail)) return false;
  return true;
}

export function assertSolveResult(value: unknown): asserts value is SolveResult {
  if (!object(value) || !text(value.finalText) || !object(value.usage)) invalid("solve");
  const usage = value.usage;
  if (!["inputTokens", "outputTokens", "totalTokens"].every(name => tokenCount(usage[name]))) invalid("usage");
  if (value.observations !== undefined && !jsonValue(value.observations)) invalid("solve.observations");
}

export function assertVerifyResult(value: unknown): asserts value is VerifyResult {
  // Absence means not measured, never zero; a present reward must be finite.
  if (!object(value) || (value.score !== undefined && (typeof value.score !== "number" || !Number.isFinite(value.score))) ||
    (typeof value.passed !== "boolean" && value.passed !== null) || !jsonValue(value.details)) invalid("verdict");
  if (Object.hasOwn(value, "trajectory")) invalid("verdict.trajectory is no longer supported");
  if (object(value.details) && Object.hasOwn(value.details, "failedChecks")) {
    const checks = value.details.failedChecks;
    if (!Array.isArray(checks) || !checks.every(failedCheck)) invalid("verdict.details.failedChecks");
  }
}

/** Persisted JSON and remote workers are validation boundaries, even when callers are typed. */
export function assertAttemptRecord(value: unknown): asserts value is AttemptRecord {
  if (!object(value)) invalid("record");
  if (!["quality", "performance"].includes(String(value.evaluationKind)))
    invalid("evaluationKind");
  const performance = value.evaluationKind === "performance";
  const key = value.key;
  if (!object(key) || !["runId", "taskId", "attemptId"].every(name => text(key[name]) && key[name] !== ""))
    invalid("key");
  if (Object.hasOwn(value, "status") || Object.hasOwn(value, "timeoutKind")) invalid("legacy outcome fields");
  if (!["completed", "agent_timeout", "failed", "cancelled"].includes(String(value.executionStatus)) ||
    !["valid", "invalid", "not-applicable"].includes(String(value.scoreStatus)) ||
    !["cleaned", "unconfirmed"].includes(String(value.cleanupStatus))) invalid("outcome");
  if (value.accounting !== undefined) {
    if (!object(value.accounting) || typeof value.accounting.complete !== "boolean" || !(value.accounting.cost === null || elapsed(value.accounting.cost)) ||
        !(value.accounting.currency === null || text(value.accounting.currency))) invalid("accounting");
    assertSolveResult({ finalText: "", usage: value.accounting.usage });
  }
  if (value.solve !== null) assertSolveResult(value.solve);
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || !value.steps.length) invalid("steps");
    const names = new Set<string>();
    for (const step of value.steps) {
      if (!object(step) || !text(step.name) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(step.name) || names.has(step.name) ||
        step.evidencePath !== `steps/${step.name}` || !timestamp(step.startedAt) || !timestamp(step.finishedAt) ||
        !Array.isArray(step.errors) || !step.errors.every(error => object(error) && text(error.phase) && phases.has(error.phase) &&
          text(error.code) && text(error.message) && validFailureMetadata(error))) invalid("step");
      names.add(step.name);
      if (step.solve !== null) assertSolveResult(step.solve);
      if (step.verdict !== null) assertVerifyResult(step.verdict);
      if (step.accounting !== undefined && (!object(step.accounting) || typeof step.accounting.complete !== "boolean" ||
        !(step.accounting.cost === null || elapsed(step.accounting.cost)) || !(step.accounting.currency === null || text(step.accounting.currency)))) invalid("step.accounting");
      if (object(step.accounting)) assertSolveResult({ finalText: "", usage: step.accounting.usage });
    }
  }
  if (value.verdict !== null) assertVerifyResult(value.verdict);
  if (value.verdict !== null) {
    try { assertEvaluationVerdict(performance ? "performance" : "quality", value.verdict); }
    catch { invalid("verdict evaluationKind"); }
  }
  if (performance && value.executionStatus === "agent_timeout") invalid("performance Agent timeout");
  if (value.executionStatus === "completed" && (value.solve === null || value.verdict === null))
    invalid("completed result without solve/verdict");
  if (
    !Array.isArray(value.errors) ||
    !value.errors.every(
      error => object(error) && text(error.phase) && phases.has(error.phase) && text(error.code) && text(error.message) && validFailureMetadata(error),
    )
  )
    invalid("errors");
  if (value.executionStatus === "failed" && value.errors.length === 0) invalid("invalid result without failure");
  if (value.executionStatus === "agent_timeout" && (!object(value.errors[0]) || value.errors[0].phase !== "solve"))
    invalid("Agent timeout outside solve phase");
  if (
    value.warnings !== undefined &&
    (!Array.isArray(value.warnings) ||
      !value.warnings.every(
        warning =>
          object(warning) &&
          text(warning.phase) &&
          phases.has(warning.phase) &&
          isErrorCode(warning.code) &&
          text(warning.message) && Object.keys(warning).every(key => ["phase", "code", "message"].includes(key)),
      ))
  )
    invalid("warnings");
  const scored = value.executionStatus === "completed" || value.executionStatus === "agent_timeout";
  if (performance ? value.scoreStatus !== "not-applicable" : (value.scoreStatus === "valid") !== scored || value.scoreStatus === "not-applicable")
    invalid("outcome consistency");
  if (value.executionStatus === "agent_timeout" && value.verdict !== null) invalid("Agent timeout with verdict");
  if (value.cleanupStatus === "cleaned" && value.errors.some(error => object(error) && error.phase === "cleanup")) invalid("cleanupStatus");
  const completeness = ["complete", "partial", "missing", "not-produced"];
  if (
    !object(value.collection) ||
    !text(value.collection.trajectory) ||
    !completeness.includes(value.collection.trajectory) ||
    !text(value.collection.artifacts) ||
    !completeness.includes(value.collection.artifacts)
  )
    invalid("collection");
  if (value.trajectory !== undefined && value.trajectory !== TRAJECTORY_EVIDENCE_PATH) invalid("trajectory");
  if (!object(value.environments) || !jsonValue(value.environments.solve) || !jsonValue(value.environments.verify))
    invalid("environments");
  if (value.environments.verificationRuntime !== undefined && !jsonValue(value.environments.verificationRuntime))
    invalid("environments.verificationRuntime");
  if (value.task !== undefined) {
    if (!object(value.task) || !text(value.task.prompt) || value.task.prompt.trim() === "") invalid("task");
    const taskKeys = Object.keys(value.task);
    if (taskKeys.some(key => key !== "prompt" && key !== "answer")) invalid("task");
    if (
      Object.hasOwn(value.task, "answer") &&
      (value.task.answer === null || value.task.answer === undefined || !jsonValue(value.task.answer))
    )
      invalid("task.answer");
  }
  if (!timestamp(value.startedAt) || !timestamp(value.finishedAt) || !elapsed(value.durationMs)) invalid("timing");
  if (value.readiness !== undefined && (!object(value.readiness) ||
    !text(value.readiness.roundId) || !value.readiness.roundId || !timestamp(value.readiness.readyAt) ||
    !elapsed(value.readiness.queueDurationMs))) invalid("readiness");
  if (
    !object(value.phaseDurationMs) ||
    !Object.entries(value.phaseDurationMs).every(([phase, duration]) => phases.has(phase) && elapsed(duration))
  )
    invalid("phaseDurationMs");
}

export function trajectoryType(value: unknown, key: AttemptKey, sequence: number): string {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.seq !== sequence ||
    !timestamp(value.at) ||
    !object(value.key) ||
    !text(value.type) ||
    !value.type ||
    !jsonValue(value.data) ||
    value.key.runId !== key.runId ||
    value.key.taskId !== key.taskId ||
    value.key.attemptId !== key.attemptId
  ) {
    throw new TypeError("Invalid trajectory event schema, identity, timestamp or sequence");
  }
  if (sequence === 1 && value.type !== "start") throw new TypeError("Trajectory must start with start event");
  return value.type;
}
