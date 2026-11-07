import type { AttemptRecord, AttemptSummary, RunManifest } from "../contracts/result.js";
import { assertAttemptRecord } from "./record-validation.js";
import { hasUnconfirmedCleanup, isEvaluationComplete } from "./evaluation-outcome.js";
import { ResumeError } from "../recovery/resume-error.js";

/** Allocation ordinals, never filesystem timestamps, select the current attempt. */
export function selectAttemptRecords(run: RunManifest, attempts: AttemptSummary[]): AttemptRecord[] {
  const selected = new Set(run.taskIds);
  const groups = new Map<string, AttemptSummary[]>();
  for (const item of attempts) {
    if (item.key.runId !== run.runId || !selected.has(item.key.taskId) || !item.key.attemptId)
      throw new ResumeError("STORE_RECORD_INVALID", "Attempt identity differs from locked run selection");
    const group = groups.get(item.key.taskId) ?? [];
    if (
      !Number.isSafeInteger(item.ordinal) ||
      item.ordinal < 1 ||
      group.some(previous => previous.ordinal === item.ordinal)
    )
      throw new ResumeError("STORE_RECORD_INVALID", "Invalid or duplicate attempt ordinal");
    if (group.some(previous => previous.key.attemptId === item.key.attemptId))
      throw new ResumeError("STORE_RECORD_INVALID", "Duplicate attempt identity");
    if (item.record) {
      assertAttemptRecord(item.record);
      if (item.record.evaluationKind !== run.evaluationKind)
        throw new ResumeError("STORE_RECORD_INVALID", "Attempt evaluation kind differs from its run");
      if (
        item.record.key.runId !== item.key.runId ||
        item.record.key.taskId !== item.key.taskId ||
        item.record.key.attemptId !== item.key.attemptId
      )
        throw new ResumeError("STORE_RECORD_INVALID", "Record identity differs from its allocation");
    }
    group.push(item);
    groups.set(item.key.taskId, group);
  }
  const records: AttemptRecord[] = [];
  for (const taskId of run.taskIds) {
    const group = groups.get(taskId) ?? [];
    // Retries keep the full attempt history, so several terminal records per
    // task are legitimate; the completed one wins and must stay the latest.
    const resolved = group.filter(item => item.record && item.record.executionStatus !== "cancelled");
    const completed = resolved.filter(item => isEvaluationComplete(item.record!));
    if (completed.length > 1)
      throw new ResumeError("STORE_RECORD_INVALID", `Conflicting completed attempts for ${taskId}`);
    if (completed.length === 1 && resolved.some(item => item.ordinal > completed[0]!.ordinal)) {
      throw new ResumeError("STORE_RECORD_INVALID", `Conflicting attempts recorded after completion for ${taskId}`);
    }
    const latest = group.reduce<AttemptSummary | undefined>(
      (value, item) => (!value || item.ordinal > value.ordinal ? item : value),
      undefined,
    );
    const record = completed[0]?.record ?? latest?.record;
    if (record) records.push(structuredClone(record));
  }
  return records;
}


export function resolveRunStatus(snapshot: { run: RunManifest; records: AttemptRecord[]; pendingTaskIds: string[] }): RunManifest["status"] {
  if (!snapshot.run.source || snapshot.run.failure || snapshot.pendingTaskIds.length ||
      snapshot.records.length !== snapshot.run.taskIds.length || snapshot.records.some(record => !isEvaluationComplete(record) || hasUnconfirmedCleanup(record))) return "error";
  return "completed";
}
