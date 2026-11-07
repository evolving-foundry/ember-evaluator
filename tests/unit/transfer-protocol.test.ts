import { expect, test } from "vitest";
import { validateUploadManifest } from "../../src/infrastructure/transfer/protocol.js";
import { finalizeAttemptOutcome } from "../../src/core/results/evaluation-outcome.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";

function upload() {
  const result = storeRecord();
  finalizeAttemptOutcome(result);
  result.trajectory = "agent/trajectory.jsonl";
  result.readiness = { roundId: "round", readyAt: result.startedAt, queueDurationMs: 0 };
  result.task = { prompt: "public prompt" };
  result.warnings = [];
  return { schemaVersion: 1, key: result.key, transferId: result.key.attemptId, files: [], missing: [], result };
}

test("remote uploads preserve current outcome, readiness and task evidence", () => {
  const value = upload();
  expect(validateUploadManifest(JSON.parse(JSON.stringify(value)))).toEqual(value);
});

test("remote uploads retain attempt accounting", () => {
  const value = upload();
  value.result.accounting = { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }, cost: null, currency: null, complete: true };
  expect(validateUploadManifest(JSON.parse(JSON.stringify(value)))).toEqual(value);
});

test("remote uploads reject malformed attempt accounting", () => {
  const value = upload();
  value.result.accounting = { usage: { inputTokens: -1, outputTokens: 8, totalTokens: 7 }, cost: null, currency: null, complete: false };
  expect(() => validateUploadManifest(value)).toThrow(/Invalid uploaded attempt/);
  value.result.accounting.usage.inputTokens = 12;
  value.result.accounting.usage.totalTokens = 20;
  value.result.accounting.cost = -1;
  expect(() => validateUploadManifest(value)).toThrow(/Invalid uploaded attempt/);
});

test("remote uploads preserve continuous quality and scoreless performance", () => {
  const value = upload();
  value.result.verdict = { passed: null, score: 0.75, details: {} };
  expect(validateUploadManifest(value).result.verdict).toMatchObject({ passed: null, score: 0.75 });
  value.result.evaluationKind = "performance";
  value.result.verdict = { passed: null, details: {} };
  finalizeAttemptOutcome(value.result);
  expect(validateUploadManifest(value).result.scoreStatus).toBe("not-applicable");
  value.result.verdict.score = 1;
  expect(() => validateUploadManifest(value)).toThrow(/Invalid uploaded attempt/);
});

test("remote uploads still reject unknown fields and invalid outcomes", () => {
  const value = upload();
  expect(() => validateUploadManifest({ ...value, result: { ...value.result, unknown: true } })).toThrow(/protocol fields/);
  Reflect.set(value.result, "scoreStatus", "pending");
  expect(() => validateUploadManifest(value)).toThrow(/Invalid uploaded attempt/);
});
