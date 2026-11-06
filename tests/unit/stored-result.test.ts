import { expect, test } from "vitest";
import { upgradeStoredResult } from "../../src/core/results/stored-result.js";
import { assertAttemptRecord } from "../../src/core/results/record-validation.js";
import { fixtureFailure, storeRecord } from "../fixtures/results/store-fixture.js";
import { classifyError } from "../../src/core/errors/classify.js";

test("historical automatic network policy converts only on local reads", () => {
  const current = classifyError(new Error("ECONNRESET"), { phase: "solve" });
  const old = { ...current, scope: "attempt", action: "retry_attempt", retryable: true };
  const value = { ...storeRecord(), executionStatus: "failed", scoreStatus: "invalid", solve: null, verdict: null, errors: [old] };
  expect(() => assertAttemptRecord(value)).toThrow(/errors/);
  upgradeStoredResult(value);
  expect(() => assertAttemptRecord(value)).not.toThrow();
  expect(value.errors[0]).toMatchObject({ code: "NETWORK_FAILURE", scope: "request", action: "finalize", retryable: false });
  expect(old).toMatchObject({ scope: "attempt", action: "retry_attempt", retryable: true });
});

test.each(["TASK_DATA_INVALID", "PLUGIN_PRIVATE_CODE"])("new records reject a three-field error %s, local historical reads convert it", code => {
  const value = { ...storeRecord(), solve: null, verdict: null,
    executionStatus: "failed", scoreStatus: "invalid", cleanupStatus: "cleaned",
    errors: [{ phase: "prepare", code, message: "historical input" }] };
  expect(() => assertAttemptRecord(value)).toThrow(/errors/);
  upgradeStoredResult(value);
  expect(() => assertAttemptRecord(value)).not.toThrow();
  expect(value.errors[0]).toMatchObject({ schemaVersion: 1, code: "TASK_DATA_INVALID" });
  if (code === "PLUGIN_PRIVATE_CODE") expect(value.errors[0]).toMatchObject({ details: { originalCode: code } });
});

test("historical read conversion does not repair partially versioned or forged errors", () => {
  for (const extra of [{ retryable: true }, { schemaVersion: 1 }, { headers: { authorization: "private" } }]) {
    const value = { ...storeRecord(), errors: [{ phase: "solve", code: "INTERNAL_ERROR", message: "bad", ...extra }] };
    upgradeStoredResult(value);
    expect(() => assertAttemptRecord(value)).toThrow(/errors/);
  }
});

test("only historical reads move a verdict trajectory to the attempt", () => {
  const value = { ...storeRecord(), verdict: { passed: true, details: {}, trajectory: "agent/trajectory.jsonl" } };
  expect(() => assertAttemptRecord(value)).toThrow(/verdict.trajectory/);
  upgradeStoredResult(value);
  expect(() => assertAttemptRecord(value)).not.toThrow();
  expect(value).toHaveProperty("trajectory", "agent/trajectory.jsonl");
  expect(value.verdict).not.toHaveProperty("trajectory");
});

test("historical trajectory conversion rejects unsafe old paths", () => {
  const value = { ...storeRecord(), verdict: { passed: true, details: {}, trajectory: "../private.jsonl" } };
  upgradeStoredResult(value);
  expect(() => assertAttemptRecord(value)).toThrow(/trajectory/);
});

test.each([
  ["completed", undefined, "completed", "valid"],
  ["timeout", "agent", "agent_timeout", "valid"],
  ["invalid", "infrastructure", "failed", "invalid"],
  ["error", undefined, "failed", "invalid"],
  ["cancelled", undefined, "cancelled", "invalid"],
  ["unsupported", undefined, "failed", "invalid"],
])("historical %s is converted once to current execution and score states", (status, timeoutKind, executionStatus, scoreStatus) => {
  const { executionStatus: _execution, scoreStatus: _score, cleanupStatus: _cleanup, evaluationKind: _kind, ...old } = storeRecord();
  const value = { ...old, status, ...(timeoutKind ? { timeoutKind } : {}),
    ...(status === "completed" ? {} : { solve: null, verdict: null, errors: [fixtureFailure("solve", "INTERNAL_ERROR", "old failure")] }) };
  upgradeStoredResult(value);
  expect(() => assertAttemptRecord(value)).not.toThrow();
  expect(value).toMatchObject({ evaluationKind: "quality", executionStatus, scoreStatus, cleanupStatus: "cleaned" });
  expect(value).not.toHaveProperty("status"); expect(value).not.toHaveProperty("timeoutKind");
});

test("historical conversion rejects inconsistent declared states and malformed timeout attribution", () => {
  for (const extra of [{ status: "invalid" }, { status: "completed", timeoutKind: "agent" }, { status: "completed", scoreStatus: "invalid" }])
    expect(() => upgradeStoredResult({ ...storeRecord(), ...extra })).toThrow(/historical/);
});
