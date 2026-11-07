import { validPreparationBudget, assertPreparationDiagnostics } from "../../core/preparation/preparation-validation.js";
import { assertJsonValue, expectRecord, expectNonEmptyString } from "../../core/validation/input.js";
import { validFailureMetadata } from "../../core/errors/validation.js";
import type { WarmupSummary } from "../warmup.js";

/** The remote coordinator owns preparation details; validate the terminal summary before reporting success. */
export function parseWarmupSummary(value: unknown): WarmupSummary {
  assertJsonValue(value);
  const result = expectRecord(value, "Ray warmup summary");
  const ids = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.some(id => typeof id !== "string" || !id)) throw new TypeError("Invalid warmup task IDs");
    const values = input.map(id => expectNonEmptyString(id, "task ID"));
    if (new Set(values).size !== values.length) throw new TypeError("Duplicate warmup task IDs");
    return values;
  };
  const taskIds = ids(result.taskIds), ready = ids(result.readyTaskIds);
  if (!["ready", "error"].includes(String(result.status)) || typeof result.durationMs !== "number" ||
      !Number.isFinite(result.durationMs) || result.durationMs < 0 || !Array.isArray(result.failures) ||
      !Array.isArray(result.preparationRounds) || !Array.isArray(result.placements)) throw new TypeError("Invalid warmup summary");
  const failures = result.failures.map(item => {
    const failure = expectRecord(item, "warmup failure");
    const metadata = expectRecord(failure.failure, "failure metadata");
    if (!validFailureMetadata(metadata) || !["prepare", "install", "environment", "solve", "transfer", "verify", "collect", "cleanup", "store"].includes(String(metadata.phase)))
      throw new TypeError("Invalid warmup failure metadata");
    return expectNonEmptyString(failure.taskId, "failed task ID");
  });
  const accounted = [...ready, ...failures];
  if (new Set(accounted).size !== accounted.length || accounted.some(id => !taskIds.includes(id)) ||
      (result.status === "ready" && (failures.length || ready.length !== taskIds.length)) ||
      (result.status === "error" && failures.length === 0)) throw new TypeError("Inconsistent warmup status");
  const placed = new Set<string>();
  for (const item of result.placements) {
    const placement = expectRecord(item, "warmup placement");
    const taskId = expectNonEmptyString(placement.taskId, "placement task ID");
    expectNonEmptyString(placement.nodeId, "placement node ID");
    if (!taskIds.includes(taskId) || placed.has(taskId)) throw new TypeError("Invalid warmup placement");
    placed.add(taskId);
  }
  for (const item of result.preparationRounds) {
    const round = expectRecord(item, "warmup preparation round");
    ids(round.taskIds);
    for (const key of ["id", "startedAt"]) expectNonEmptyString(round[key], `round.${key}`);
    const policy = expectRecord(round.policy, "preparation policy");
    expectNonEmptyString(policy.version, "policy.version"); expectNonEmptyString(policy.source, "policy.source");
    if (!["ready", "error", "cancelled"].includes(String(round.status)) || !validPreparationBudget(round) ||
        typeof round.finishedAt !== "string" || (round.tasks !== undefined && !Array.isArray(round.tasks)))
      throw new TypeError("Invalid terminal preparation round");
    assertPreparationDiagnostics(round);
  }
  // Details are JSON produced by the version-checked coordinator; they remain diagnostic data.
  return structuredClone(result) as WarmupSummary;
}
