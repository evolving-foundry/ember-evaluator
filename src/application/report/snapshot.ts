import { assertJsonValue } from "../../core/validation/input.js";
import type { PreparationRound, ResultSnapshot } from "../../core/contracts/result.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { resolveRunStatus } from "../../core/results/task-result-resolver.js";

function preparationForTask(round: PreparationRound, taskId: string): PreparationRound {
  const tasks = round.tasks?.filter(task => task.taskId === taskId);
  const timing = tasks?.[0];
  const { error: _error, failure: _failure, ...rest } = round;
  let status: PreparationRound["status"] = "preparing";
  if (timing?.status === "ready" || timing?.status === "error" || timing?.status === "cancelled") status = timing.status;
  return { ...rest, taskIds: [taskId],
    ...(tasks ? { tasks } : {}),
    ...(round.placements ? { placements: round.placements.filter(item => item.taskId === taskId) } : {}),
    startedAt: timing?.queuedAt ?? round.startedAt,
    finishedAt: timing?.finishedAt ?? null,
    status,
    ...(timing?.error ? { error: timing.error } : {}),
    ...(timing?.failure ? { failure: timing.failure } : {}),
  };
}

/** Select before computing metrics, including accounting for previous attempts. */
export function taskReportSnapshot(snapshot: ResultSnapshot, taskId: string): ResultSnapshot {
  if (!snapshot.run.taskIds.includes(taskId)) throw new TypeError(`Unknown report task: ${taskId}`);
  const scoped = structuredClone(snapshot);
  scoped.records = scoped.records.filter(record => record.key.taskId === taskId);
  scoped.pendingTaskIds = scoped.pendingTaskIds.filter(id => id === taskId);
  if (scoped.attemptHistory) scoped.attemptHistory = scoped.attemptHistory.filter(attempt => attempt.key.taskId === taskId);
  scoped.run.taskIds = [taskId];
  if (scoped.run.preparationRounds) scoped.run.preparationRounds = scoped.run.preparationRounds
    .filter(round => round.taskIds.includes(taskId)).map(round => preparationForTask(round, taskId));
  if (scoped.run.remoteAttempts) scoped.run.remoteAttempts = scoped.run.remoteAttempts.filter(attempt => attempt.key.taskId === taskId);
  // Parent failures and wall time belong to the index, not to a different task.
  delete scoped.run.failure;
  delete scoped.run.initializationFailures;
  const record = scoped.records[0];
  scoped.run.startedAt = record?.startedAt ?? scoped.run.startedAt;
  scoped.run.finishedAt = record?.finishedAt ?? null;
  scoped.run.durationMs = record?.durationMs ?? null;
  scoped.run.status = record?.executionStatus === "cancelled" ? "cancelled" : resolveRunStatus(scoped);
  if (!record && snapshot.run.status === "running") scoped.run.status = "running";
  const { digest: _digest, ...value } = scoped;
  assertJsonValue(value, "task report snapshot");
  scoped.digest = fingerprintConfig(value);
  return scoped;
}
