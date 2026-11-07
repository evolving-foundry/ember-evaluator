import { expect, test } from "vitest";
import { classifyError, normalizeFailure } from "../../src/core/errors/classify.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { validFailureMetadata } from "../../src/core/errors/validation.js";
import { failureDecision } from "../../src/core/policies/error-policy.js";
import { isManualRetryEligible } from "../../src/core/recovery/manual-retry.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";

const context = { phase: "environment", component: "docker", operation: "build" } as const;

test.each([
  "Err:1 https://mirror.example/ubuntu noble InRelease\n  503 Service Unavailable",
  "Could not connect to mirror.example:443 (192.0.2.1), connection timed out",
  "Temporary failure resolving 'mirror.example'",
  "pip install: ReadTimeout",
  "HTTP 503 Service Unavailable",
  "ECONNRESET",
  "curl: (28) Operation timed out",
  "[... build output truncated ...]\nexit code: 100",
  "make: *** Error 2",
  "strip: unable to copy file '/usr/local/bin/ffmpeg'; reason: Text file busy",
])("build failure never grants whole-task retry: %s", message => {
  const failure = classifyError(new EvaluatorError("ENV_IMAGE_BUILD_FAILED", "Docker build failed",
    { operation: "build" }, { cause: new Error(message) }), context);
  expect(failure).toMatchObject({ code: "ENV_IMAGE_BUILD_FAILED", retryable: false, action: "finalize" });
  expect(failureDecision(failure).retryable).toBe(false);
  expect(validFailureMetadata(failure)).toBe(true);
  expect(normalizeFailure(JSON.parse(JSON.stringify(failure)))).toMatchObject({ code: "ENV_IMAGE_BUILD_FAILED", retryable: false });
  expect(isManualRetryEligible({ ...storeRecord(), executionStatus: "failed", scoreStatus: "invalid",
    solve: null, verdict: null, errors: [failure] })).toBe(false);
});

test("raw Docker build diagnostics and wrapped preparation errors retain the build code", () => {
  const failure = classifyError(new Error("HTTP 503"), context);
  expect(failure).toMatchObject({ code: "ENV_IMAGE_BUILD_FAILED", retryable: false });
  expect(classifyError(new EvaluatorError("ENV_PREPARATION_FAILED", "preparation failed", {}, {
    cause: new EvaluatorError("ENV_IMAGE_BUILD_FAILED", "pip: ReadTimeout", { operation: "build" }),
  }), { phase: "prepare" })).toMatchObject({ code: "ENV_IMAGE_BUILD_FAILED", retryable: false });
});

test("persisted build evidence and remote retry flags cannot request another attempt", () => {
  const failure = classifyError(new EvaluatorError("ENV_IMAGE_BUILD_FAILED", "Docker build failed", {
    operation: "build", networkStage: "docker-build", networkReason: "http-transient", networkEvidence: "HTTP 503", httpStatus: 503,
  }), context);
  const forged = { ...failure, retryable: true, action: "retry_attempt" as const };
  expect(validFailureMetadata(forged)).toBe(false);
  expect(failureDecision(forged).retryable).toBe(false);
  expect(isManualRetryEligible({ ...storeRecord(), executionStatus: "failed", scoreStatus: "invalid",
    solve: null, verdict: null, errors: [forged] })).toBe(false);
});

test("model and pull network failures are terminal after operation retries", () => {
  expect(classifyError(new Error("HTTP 503"), { phase: "solve" })).toMatchObject({ code: "NETWORK_FAILURE", retryable: false });
  expect(classifyError(new Error("HTTP 503"), { phase: "environment", operation: "pull" }))
    .toMatchObject({ code: "NETWORK_FAILURE", retryable: false });
});
