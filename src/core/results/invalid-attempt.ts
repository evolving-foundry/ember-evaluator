import type { AttemptKey, AttemptPaths, AttemptRecord, Failure, EvaluationKind } from "../contracts/result.js";
import type { RunStore } from "../contracts/run-store.js";
import { buildFileManifest } from "../artifacts/artifacts.js";
import { normalizeFailure } from "../errors/classify.js";

/** Coordinator evidence of infrastructure failure; never impersonates a worker verdict. */
export async function saveInvalidAttempt(
  store: RunStore,
  key: AttemptKey,
  paths: AttemptPaths,
  startedAt: string,
  errors: Failure[],
  evaluationKind: EvaluationKind,
): Promise<AttemptRecord> {
  const finishedAt = new Date().toISOString();
  const files = await buildFileManifest(paths.root, []);
  const record: AttemptRecord = {
    key, evaluationKind,
    solve: null, verdict: null, errors: errors.map(error => normalizeFailure(error)),
    executionStatus: "failed", scoreStatus: evaluationKind === "performance" ? "not-applicable" : "invalid",
    cleanupStatus: errors.some(error => error.phase === "cleanup") ? "unconfirmed" : "cleaned",
    collection: { trajectory: "missing", artifacts: "missing" },
    environments: { solve: null, verify: null }, startedAt, finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)), phaseDurationMs: {},
  };
  await store.commit(record, files);
  return record;
}
