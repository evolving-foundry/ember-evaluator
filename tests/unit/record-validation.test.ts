import { expect, test } from "vitest";
import { assertAttemptRecord } from "../../src/core/results/record-validation.js";
import { fixtureFailure, storeRecord } from "../fixtures/results/store-fixture.js";

test("accepts a disclosed prompt without requiring a textual answer", () => {
  expect(() => assertAttemptRecord({ ...storeRecord(), task: { prompt: "What is 2+2?" } })).not.toThrow();
  expect(() => assertAttemptRecord({ ...storeRecord(), task: { prompt: "What is 2+2?", answer: "4" } })).not.toThrow();
});

test.each([
  { task: { prompt: " " } },
  { task: { prompt: "question", answer: null } },
  { task: { prompt: "question", taskDir: "/tmp" } },
])("rejects malformed disclosed task: $task", ({ task }) => {
  expect(() => assertAttemptRecord({ ...storeRecord(), task })).toThrow(/task/);
});

test("accepts historical records and nonfatal warnings on completed records", () => {
  expect(() => assertAttemptRecord(storeRecord())).not.toThrow();
  expect(() => assertAttemptRecord({ ...storeRecord(), warnings: [{ phase: "transfer", code: "TRANSFER_UNSAFE", message: "omitted link" }] })).not.toThrow();
});

test("execution and score states distinguish Agent budgets from infrastructure failure", () => {
  const agent = { ...storeRecord(), executionStatus: "agent_timeout", scoreStatus: "valid", solve: null, verdict: null,
    errors: [fixtureFailure("solve", "SOLVER_AGENT_TIMEOUT", "budget exhausted")] };
  expect(() => assertAttemptRecord(agent)).not.toThrow();
  expect(() => assertAttemptRecord({ ...agent, executionStatus: "completed" })).toThrow(/solve/);
  expect(() => assertAttemptRecord({ ...agent, verdict: { passed: true, details: {} } })).toThrow(/verdict/);
  expect(() => assertAttemptRecord({ ...agent, errors: [fixtureFailure("environment", "ENV_PREPARATION_TIMEOUT", "build timed out")] })).toThrow(/outside solve/);
  const invalid = { ...agent, executionStatus: "failed", scoreStatus: "invalid" };
  expect(() => assertAttemptRecord(invalid)).not.toThrow();
  expect(() => assertAttemptRecord({ ...invalid, errors: [] })).toThrow(/without failure/);
  expect(() => assertAttemptRecord({ ...invalid, executionStatus: "agent_timeout" })).toThrow(/outcome/);
});

test("current outcome fields are required and legacy duplicates are rejected", () => {
  for (const field of ["evaluationKind", "executionStatus", "scoreStatus", "cleanupStatus"]) {
    const value = storeRecord(); Reflect.deleteProperty(value, field);
    expect(() => assertAttemptRecord(value)).toThrow();
  }
  for (const old of [{ status: "completed" }, { timeoutKind: "agent" }])
    expect(() => assertAttemptRecord({ ...storeRecord(), ...old })).toThrow(/legacy outcome/);
});

test("accepts the solver runtime install phase", () => {
  const record = storeRecord();
  expect(() => assertAttemptRecord({ ...record, phaseDurationMs: { ...record.phaseDurationMs, install: 12 } })).not.toThrow();
  expect(() => assertAttemptRecord({ ...record, warnings: [{ phase: "install", code: "ENV_RUNTIME_INSTALL_FAILED", message: "cached" }] })).not.toThrow();
});

test("accepts a collected trajectory path and named failed checks", () => {
  const record = storeRecord();
  record.trajectory = "agent/trajectory.jsonl";
  record.verdict = {
    score: 0.98,
    passed: false,
    details: { failedChecks: [{ name: "no_common_output_file_created", group: "response_contract", detail: "unexpected" }] },
  };
  expect(() => assertAttemptRecord(record)).not.toThrow();
});

test("accepts a record-level trajectory path without a verdict and rejects other paths", () => {
  expect(() => assertAttemptRecord({ ...storeRecord(), solve: null, verdict: null, executionStatus: "agent_timeout", scoreStatus: "valid",
    errors: [fixtureFailure("solve", "SOLVER_AGENT_TIMEOUT", "budget")], trajectory: "agent/trajectory.jsonl" })).not.toThrow();
  for (const trajectory of ["agent/other.jsonl", "../agent/trajectory.jsonl", null])
    expect(() => assertAttemptRecord({ ...storeRecord(), trajectory })).toThrow(/trajectory/);
});

test.each([
  { trajectory: "/tmp/trajectory.jsonl" },
  { trajectory: "agent/other.jsonl" },
  { details: { failedChecks: [{ name: "" }] } },
  { details: { failedChecks: [{ name: "check", path: "secret" }] } },
])("rejects malformed verdict evidence: %j", patch => {
  expect(() => assertAttemptRecord({
    ...storeRecord(),
    verdict: { score: 0, passed: false, details: {}, ...patch },
  })).toThrow(/verdict/);
});

test.each([null, {}, [null], [{ phase: "unknown", code: "skip", message: "link" }], [{ phase: "transfer", code: 1, message: "link" }], [{ phase: "transfer", code: "skip" }]].map(warnings => ({ warnings })))("rejects malformed persisted warnings: $warnings", ({ warnings }) => {
  expect(() => assertAttemptRecord({ ...storeRecord(), warnings })).toThrow(/warnings/);
});

test("a verdict without a score is valid: correctness does not require a reward", () => {
  const record = storeRecord();
  record.verdict = { passed: true, details: { checks: ["exact"] } };
  expect(() => assertAttemptRecord(record)).not.toThrow();
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, "1", null])("a present score must still be a finite number: %s", score => {
  expect(() => assertAttemptRecord({ ...storeRecord(), verdict: { score, passed: true, details: {} } })).toThrow(/verdict/);
});
