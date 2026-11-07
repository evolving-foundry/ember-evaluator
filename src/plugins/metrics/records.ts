import { selectAttemptRecords } from "../../core/results/task-result-resolver.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import type { AttemptRecord, ResultSnapshot } from "../../core/contracts/result.js";
import { isInvalidEvaluation } from "../../core/results/evaluation-outcome.js";

/** A corrupt snapshot is an error, not an opportunity to silently change its denominator. */
export function selectedRecords(snapshot: ResultSnapshot): AttemptRecord[] {
  if (snapshot.attemptHistory) {
    const current = selectAttemptRecords(snapshot.run, snapshot.attemptHistory);
    if (fingerprintConfig(current) !== fingerprintConfig(snapshot.records)) throw new Error("Snapshot current results differ from attempt history");
  }
  const selected = new Set(snapshot.run.taskIds);
  const seen = new Set<string>();
  if (selected.size !== snapshot.run.taskIds.length) throw new Error("Duplicate selected task ID");
  for (const record of snapshot.records) {
    if (record.evaluationKind !== snapshot.run.evaluationKind)
      throw new Error("Record evaluation kind differs from the run");
    if (!selected.has(record.key.taskId) || record.key.runId !== snapshot.run.runId)
      throw new Error("Record does not belong to the selected run");
    if (seen.has(record.key.taskId)) throw new Error("Duplicate task record in snapshot");
    seen.add(record.key.taskId);
  }
  const pending = new Set(snapshot.pendingTaskIds);
  if (pending.size !== snapshot.pendingTaskIds.length || [...pending].some(id => !selected.has(id)))
    throw new Error("Invalid pending task IDs");
  return snapshot.records;
}

/** Historical unclassified failures retain their original conservative denominator. */
export function scoringRecords(snapshot: ResultSnapshot) {
  const all = selectedRecords(snapshot);
  if (snapshot.run.evaluationKind === "performance")
    return { records: [], selected: snapshot.run.taskIds.length, denominator: 0, invalid: 0 };
  const invalid = all.filter(isInvalidEvaluation).length;
  return { records: all.filter(record => record.executionStatus !== "cancelled" && !isInvalidEvaluation(record)),
    selected: snapshot.run.taskIds.length, denominator: snapshot.run.taskIds.length - invalid, invalid };
}
