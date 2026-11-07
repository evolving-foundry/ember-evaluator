import { PhaseTimeoutError } from "../../src/core/policies/phase-timeout.js";
import { TaskQueue } from "../../src/core/execution/task-queue.js";
import { onDemand } from "../../src/core/preparation/task-preparation.js";
import { expect, test, vi } from "vitest";
import { classifyError, declaredErrorCode, normalizeFailure, type ErrorContext } from "../../src/core/errors/classify.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { validFailureMetadata } from "../../src/core/errors/validation.js";
import { ERROR_CODES, type ErrorCode } from "../../src/core/errors/registry.js";
import { failureDecision, requiresDispatchStop } from "../../src/core/policies/error-policy.js";
import { isManualRetryEligible } from "../../src/core/recovery/manual-retry.js";
import { assertAttemptRecord } from "../../src/core/results/record-validation.js";
import { assertPreparationDiagnostics } from "../../src/core/preparation/preparation-validation.js";
import { finalizeAttemptOutcome, evaluationScore } from "../../src/core/results/evaluation-outcome.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";

const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
const cases: [unknown, ErrorContext, ErrorCode][] = [
  [new PhaseTimeoutError("solve"), { phase: "solve" }, "SOLVER_AGENT_TIMEOUT"],
  [new PhaseTimeoutError("verify"), { phase: "verify" }, "VERIFY_TIMEOUT"],
  [coded("SOLVER_AGENT_TIMEOUT"), { phase: "solve" }, "SOLVER_AGENT_TIMEOUT"],
  [coded("ETIMEDOUT"), { phase: "solve" }, "NETWORK_FAILURE"],
  [new DOMException("deadline", "TimeoutError"), { phase: "environment", operation: "pull" }, "ENV_IMAGE_PULL_TIMEOUT"],
  [new DOMException("deadline", "TimeoutError"), { phase: "prepare", operation: "build" }, "ENV_IMAGE_BUILD_TIMEOUT"],
  [new DOMException("deadline", "TimeoutError"), { phase: "install" }, "ENV_PREPARATION_TIMEOUT"],
  [new Error("exec format error"), { phase: "environment", operation: "start" }, "ENV_ARCH_UNSUPPORTED"],
  [coded("ENOSPC"), { phase: "environment" }, "ENV_RESOURCE_EXHAUSTED"],
  [new Error("Cannot connect to the Docker daemon"), { phase: "environment" }, "ENV_DOCKER_DAEMON_UNAVAILABLE"],
  [new Error("HTTP 403 forbidden"), { phase: "environment", operation: "pull" }, "ENV_IMAGE_PULL_FAILED"],
  [new Error("HTTP 429"), { phase: "prepare", component: "source" }, "NETWORK_FAILURE"],
  [new Error("HTTP 403 Consumer is forbidden"), { phase: "solve" }, "MODEL_AUTH_FAILED"],
  [coded("INTERNAL_ERROR", "401 Consumer authentication failed."), { phase: "solve" }, "MODEL_AUTH_FAILED"],
  [new Error("insufficient_quota"), { phase: "solve" }, "MODEL_QUOTA_EXHAUSTED"],
  [Object.assign(new Error("busy"), { status: 429 }), { phase: "solve" }, "NETWORK_FAILURE"],
  [Object.assign(new Error("slow"), { status: 408 }), { phase: "solve" }, "NETWORK_FAILURE"],
  [coded("ECONNREFUSED"), { phase: "solve" }, "NETWORK_FAILURE"],
  [new Error("HTTP 503"), { phase: "solve" }, "NETWORK_FAILURE"],
  [new Error("maximum context length"), { phase: "solve" }, "MODEL_CONTEXT_LIMIT"],
  [new Error("HTTP 400 Bad Request"), { phase: "solve" }, "MODEL_REQUEST_INVALID"],
  [coded("SOLVER_OUTPUT_LIMIT", "max-tokens"), { phase: "solve" }, "SOLVER_OUTPUT_LIMIT"],
  [coded("SOLVER_OUTPUT_LIMIT", "bounded recovery exhausted"), { phase: "solve" }, "SOLVER_OUTPUT_LIMIT"],
  [coded("SOLVER_OUTPUT_LIMIT"), { phase: "transfer" }, "SOLVER_OUTPUT_LIMIT"],
  [coded("SOLVER_PROTOCOL_INVALID"), { phase: "solve" }, "SOLVER_PROTOCOL_INVALID"],
  [coded("SOLVER_PROCESS_CRASHED", "process exited 137"), { phase: "solve" }, "SOLVER_PROCESS_CRASHED"],
  [coded("TRANSFER_CHECKSUM_MISMATCH"), { phase: "transfer" }, "TRANSFER_CHECKSUM_MISMATCH"],
  [coded("TRANSFER_UNSAFE"), { phase: "transfer" }, "TRANSFER_UNSAFE"],
  [new DOMException("deadline", "TimeoutError"), { phase: "transfer" }, "TRANSFER_TIMEOUT"],
  [coded("VERIFY_RESULT_INVALID"), { phase: "verify" }, "VERIFY_RESULT_INVALID"],
  [coded("RAY_WORKER_LOST"), { phase: "environment" }, "RAY_WORKER_LOST"],
  [coded("RAY_PROTOCOL_INVALID"), { phase: "environment" }, "RAY_PROTOCOL_INVALID"],
  [coded("CLEANUP_TIMEOUT"), { phase: "cleanup" }, "CLEANUP_TIMEOUT"],
  [new Error("bad cleanup"), { phase: "cleanup" }, "CLEANUP_FAILED"],
  [new Error("bad yaml"), { phase: "prepare", component: "config" }, "CONFIG_INVALID"],
  [new Error("handshake failed"), { phase: "prepare", component: "scheduler" }, "SCHEDULER_UNAVAILABLE"],
  [new Error("unknown"), { phase: "solve" }, "INTERNAL_ERROR"],
];

test.each(cases)("classifies %s at %j as %s", (error, context, code) => {
  const failure = classifyError(error, context);
  expect(failure.code).toBe(code);
  expect(validFailureMetadata(failure)).toBe(true);
});

test.each(["INVALID_HARBOR_TASK", "UNSUPPORTED_HARBOR_TASK", "INVALID_RUNTIME", "DSH_INCOMPLETE", "MODEL_OUTPUT_TRUNCATED"])(
  "does not accept the removed framework code %s as an alias", code => {
    const error = coded(code, "external failure");
    expect(declaredErrorCode(error)).toBeUndefined();
    expect(classifyError(error, { phase: "solve" })).toMatchObject({
      code: "INTERNAL_ERROR", details: { originalCode: code },
    });
  },
);

test("explicit cancellation and typed errors take precedence over diagnostic guesses", () => {
  const error = new EvaluatorError("SOLVER_PROCESS_CRASHED", "HTTP 403 in a tool output", { exitCode: 137 });
  expect(classifyError(error, { phase: "solve" }).code).toBe("SOLVER_PROCESS_CRASHED");
  expect(classifyError(error, { phase: "solve", cancellation: "agent" }).code).toBe("SOLVER_AGENT_TIMEOUT");
  expect(classifyError(error, { phase: "solve", cancellation: "user" }).code).toBe("RUN_CANCELLED");
  expect(classifyError(error, { phase: "solve", cancellation: "infrastructure" }).code).toBe("RAY_HEARTBEAT_TIMEOUT");
  expect(classifyError(coded("ENV_IMAGE_PULL_FAILED", "image unavailable"), { phase: "environment" }).code).toBe("ENV_IMAGE_PULL_FAILED");
  const wrapped = Object.assign(new Error("image unavailable", { cause: new EvaluatorError("ENV_IMAGE_PULL_TIMEOUT", "pull deadline") }), { code: "ENV_IMAGE_PULL_FAILED" });
  expect(classifyError(wrapped, { phase: "prepare" }).code).toBe("ENV_IMAGE_PULL_TIMEOUT");
});

test("nested causes are bounded, cycle safe and redacted without serializing request data", () => {
  const nested = coded("ECONNRESET", "Bearer unknown-secret api_key=another-secret https://user:password@host.test/path?token=secret");
  const root = new Error("failure private-secret", { cause: nested });
  Object.assign(nested, { cause: root, request: { headers: { authorization: "must-not-serialize" } } });
  const failure = classifyError(root, { phase: "solve", secrets: ["private-secret"] });
  expect(failure).toMatchObject({ code: "NETWORK_FAILURE", details: { originalCode: "ECONNRESET" } });
  expect(failure.causes).toHaveLength(1);
  const text = JSON.stringify(failure);
  for (const secret of ["private-secret", "unknown-secret", "another-secret", "must-not-serialize", "user:"])
    expect(text).not.toContain(secret);
  expect(text).toContain("[redacted]");
  expect(normalizeFailure(failure)).toEqual(failure);
  let long: Error = new Error("end");
  for (let index = 0; index < 30; index++) long = new Error("x".repeat(5000), { cause: long });
  const bounded = classifyError(new AggregateError(Array(40).fill(long), "root"), { phase: "solve" });
  expect(bounded.causes.length).toBeLessThanOrEqual(15);
  expect(bounded.causes.every(cause => cause.message.length <= 2048)).toBe(true);
});

test("third-party getters are not evaluated during classification", () => {
  const getter = vi.fn(() => { throw new Error("unexpected getter"); });
  const error = Object.defineProperties({}, { message: { get: getter }, cause: { get: getter }, headers: { get: getter } });
  expect(classifyError(error, { phase: "solve" }).code).toBe("INTERNAL_ERROR");
  expect(getter).not.toHaveBeenCalled();
});

test("preparation never retries; forged policy metadata cannot change dispatch decisions", () => {
  for (const phase of ["prepare", "install", "environment"] as const) {
    const failure = classifyError(new EvaluatorError("MODEL_UNAVAILABLE", "down"), { phase });
    expect(failureDecision(failure)).toMatchObject({ retryable: false, action: "finalize" });
  }
  const auth = classifyError(new EvaluatorError("MODEL_AUTH_FAILED", "denied"), { phase: "solve" });
  const forged = { ...auth, retryable: true, action: "retry_attempt" as const };
  expect(failureDecision(forged)).toMatchObject({ retryable: false, action: "abort_run" });
  expect(validFailureMetadata(forged)).toBe(false);
  expect(requiresDispatchStop({ ...storeRecord(), errors: [forged] })).toBe(true);
  for (const { hint } of Object.values(ERROR_CODES)) {
    expect(hint).toMatch(/[A-Za-z]/u);
    expect(hint).not.toMatch(/\p{Script=Han}/u);
  }
});

test("Retry-After remains diagnostic evidence and never requeues a task", async () => {
  const failure = classifyError(Object.assign(new Error("busy"), { status: 429, headers: { "retry-after": "0.05", authorization: "secret" } }), { phase: "solve" });
  expect(failure.details).toMatchObject({ httpStatus: 429, retryAfterMs: 50 });
  expect(JSON.stringify(failure)).not.toContain("authorization");
  const record = { ...storeRecord(), executionStatus: "failed" as const, scoreStatus: "invalid" as const, solve: null, verdict: null, errors: [failure] };
  const job = { ...record.key, ref: { id: "a", recordKey: "a" }, configFingerprint: "test" };
  const coordinator = new TaskQueue();
  coordinator.add(onDemand(job)); coordinator.initialComplete();
  let count = 0;
  for await (const { job: next } of coordinator) { count++; coordinator.complete({ ...record, key: next }); }
  expect(count).toBe(1);
});

test("legal scores survive housekeeping failure, block refilling and never retry", () => {
  const record = storeRecord();
  record.errors = [classifyError(new DOMException("deadline", "TimeoutError"), { phase: "cleanup" })];
  finalizeAttemptOutcome(record);
  expect(record).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", cleanupStatus: "unconfirmed" });
  expect(evaluationScore(record)).toBe(1);
  expect(requiresDispatchStop(record)).toBe(true);
  expect(isManualRetryEligible(record)).toBe(false);
  expect(() => assertAttemptRecord(record)).not.toThrow();
  expect(() => assertAttemptRecord({ ...record, cleanupStatus: "cleaned" })).toThrow();
  expect(() => assertAttemptRecord({ ...record, scoreStatus: "invalid" })).toThrow();
});

test("versioned persisted failures reject unknown metadata and inconsistent policies", () => {
  const failure = classifyError(new EvaluatorError("VERIFY_TIMEOUT", "deadline"), { phase: "verify" });
  for (const patch of [{ schemaVersion: 2 }, { code: "NEW_UNKNOWN" }, { category: "model" },
    { details: { request: "secret" } }, { headers: {} }, { causes: [{ message: "x", headers: {} }] }, { retryable: true }]) {
    expect(() => assertAttemptRecord({ ...storeRecord(), executionStatus: "failed", scoreStatus: "invalid", errors: [{ ...failure, ...patch }] })).toThrow();
  }
  expect(validFailureMetadata({ phase: "solve", code: "OLD_CODE", message: "old" })).toBe(false);
  const preparation = classifyError(new Error("failed"), { phase: "prepare" });
  expect(() => assertPreparationDiagnostics({ failure: preparation })).not.toThrow();
  expect(() => assertPreparationDiagnostics({ failure: { ...preparation, retryable: true } })).toThrow();
});
