import { expect, test } from "vitest";
import { assertResumePluginVersions, planResume } from "../../src/core/recovery/resume.js";
import { assertResumeSolverProvenance, assertSolverProvenance } from "../../src/core/results/solver-provenance.js";
import { selectAttemptRecords } from "../../src/core/results/task-result-resolver.js";
import { attempt, attemptSummaries, cancelledRun } from "../fixtures/results/interrupted-run/fixture.js";

test("restarts only cancelled and uncommitted tasks in locked selection order", () => {
  expect(planResume(cancelledRun, [...attemptSummaries].reverse(), cancelledRun.configFingerprint)).toEqual({ skipTaskIds: ["a", "b"], restartTaskIds: ["c", "d"] });
});
test("preserves a completed attempt without re-execution", () => {
  expect(planResume(cancelledRun, [attempt("a", "completed")], cancelledRun.configFingerprint)).toEqual({ skipTaskIds: ["a"], restartTaskIds: ["b", "c", "d"] });
});
test.each(["failed", "cancelled"] as const)("retries a terminal %s attempt with a fresh attempt", status => {
  expect(planResume(cancelledRun, [attempt("a", status)], cancelledRun.configFingerprint)).toEqual({ skipTaskIds: [], restartTaskIds: ["a", "b", "c", "d"] });
});
test("changed config fails before choosing any tasks", () => {
  expect(() => planResume(cancelledRun, attemptSummaries, "changed")).toThrow(/configuration/i);
});

test.each([
  [{ plugin: "1" }, { plugin: "2" }],
  [{ plugin: "1" }, {}],
  [{}, { plugin: "1" }],
  [{ "cordis.patch.yaml": "old" }, { "cordis.patch.yaml": "new" }],
])("resume still rejects changed external plugins or patch metadata: %j -> %j", (previous, current) => {
  expect(() => assertResumePluginVersions(previous, current)).toThrow(/plugin versions/i);
});

test("resume accepts updated runtime assets while worker provenance checks remain exact", () => {
  const previous = { bundle: "candidate", installation: "old-installation", bridgeDigest: "old-bridge" };
  const current = { ...previous, installation: "new-installation", bridgeDigest: "new-bridge" };
  expect(() => assertResumeSolverProvenance(previous, current)).not.toThrow();
  expect(() => assertSolverProvenance(previous, current)).toThrow(/runtime differs/i);
});

test.each(["bundle", "artifact", "configuration", "harnessVersion", "cliVersion", "runnerVersion", "pythonRuntime", "pythonVersion", "lexiconRevision", "lexiconDigest"])(
  "resume still rejects changed solver %s", field => {
    expect(() => assertResumeSolverProvenance({ [field]: "old" }, { [field]: "new" })).toThrow(/differs/i);
    expect(() => assertResumeSolverProvenance({ [field]: "old" }, undefined)).toThrow(/differs/i);
    expect(() => assertResumeSolverProvenance(undefined, { [field]: "new" })).toThrow(/differs/i);
  },
);
test("cancelled history does not duplicate a later verdict", () => {
  const records = selectAttemptRecords(cancelledRun, [attempt("a", "cancelled"), attempt("a", "completed", 2)]);
  expect(records).toHaveLength(1); expect(records[0]!.key.attemptId).toBe("a-2");
});
test("latest uncommitted attempt is pending and cancelled history remains outside snapshot", () => {
  expect(selectAttemptRecords(cancelledRun, [attempt("a", "cancelled"), attempt("a", null, 2)])).toEqual([]);
  expect(selectAttemptRecords(cancelledRun, [attempt("a", "cancelled"), attempt("a", "cancelled", 2)])[0]!.key.attemptId).toBe("a-2");
});
test("multiple terminal attempts are a conflict even with identical scores", () => {
  expect(() => selectAttemptRecords(cancelledRun, [attempt("a", "completed"), attempt("a", "completed", 2)])).toThrow(/conflicting/i);
});
test("retry history resolves to the completed attempt and keeps it final", () => {
  const records = selectAttemptRecords(cancelledRun, [attempt("a", "failed"), attempt("a", "failed", 2), attempt("a", "completed", 3)]);
  expect(records).toHaveLength(1); expect(records[0]!.key.attemptId).toBe("a-3");
  expect(planResume(cancelledRun, [attempt("a", "failed"), attempt("a", "completed", 2)], cancelledRun.configFingerprint)).toEqual({ skipTaskIds: ["a"], restartTaskIds: ["b", "c", "d"] });
  expect(() => selectAttemptRecords(cancelledRun, [attempt("a", "completed"), attempt("a", "failed", 2)])).toThrow(/conflicting/i);
});
test("rejects unrelated identities and duplicate ordinals", () => {
  expect(() => selectAttemptRecords(cancelledRun, [attempt("outside", null)])).toThrow(/identity/i);
  const wrong = attempt("a", "completed"); wrong.record!.key = { ...wrong.key, runId: "other" };
  expect(() => selectAttemptRecords(cancelledRun, [wrong])).toThrow(/identity/i);
  expect(() => selectAttemptRecords(cancelledRun, [attempt("a", null), { ...attempt("a", null), key: { ...attempt("a", null).key, attemptId: "different" } }])).toThrow(/ordinal/i);
});
