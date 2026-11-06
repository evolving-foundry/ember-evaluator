import { expect, test } from "vitest";
import { kernelProfileVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";

function fixture(collection: "Default" | "PipeTimeline,Default" = "Default") {
  const candidate = "a".repeat(64);
  const reference = "b".repeat(64);
  const expected = { caseId: "fixed", seed: 42, warmup: 25, collection, problemSha256: reference };
  const metadata = {
    collection,
    diagnosticProtocol: { caseId: "fixed", seeds: [42], warmup: 25, collection,
      scope: "original-first-triton-kernel-or-file-stem", capture: "after-warmup-mstx-range", selectionPolicy: "last" },
    trace: collection === "Default" ? { status: "unavailable", reason: "not-requested-by-default-protocol" } : { status: "available" },
    sources: { candidate: { sha256: candidate }, problem: { sha256: reference } },
    replay: { seed: 42, warmup: 25, logicalDevice: 0 },
  };
  const value = { profiling: { schemaVersion: 1, status: "completed", error: "", kernels: [], artifacts: [], metadata } };
  return { candidate, expected, value, metadata };
}

test.each(["Default", "PipeTimeline,Default"] as const)("Benchmark publishes validated %s diagnostics", collection => {
  const f = fixture(collection);
  expect(kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).toMatchObject({
    passed: null, details: { protocol: "kernel-profile/v1", status: "completed", cleanup: "confirmed",
      diagnosticProtocol: { collection }, profiling: { metadata: { trace: f.metadata.trace } } },
  });
});

test("Benchmark rejects diagnostics collected under a different protocol", () => {
  const f = fixture();
  expect(() => kernelProfileVerdict(f.value, f.candidate, "pytorch", { ...f.expected, collection: "PipeTimeline,Default" })).toThrow(/protocol/);
  f.metadata.diagnosticProtocol.capture = "first-match";
  expect(() => kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).toThrow(/protocol/);
});

test("Benchmark refuses a fabricated trace availability marker", () => {
  const f = fixture();
  f.metadata.trace = { status: "available" };
  expect(() => kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).toThrow(/trace/);
});

test("Benchmark binds diagnostics to the frozen source and effective replay", () => {
  const f = fixture();
  expect(() => kernelProfileVerdict(f.value, "c".repeat(64), "pytorch", f.expected)).toThrow(/source/);
  f.metadata.replay.seed = 0;
  expect(() => kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).toThrow(/replay/);
});

test("unavailable capture retains a diagnostic verdict without a candidate score", () => {
  const f = fixture();
  f.value.profiling.status = "failed";
  f.value.profiling.error = "collection unavailable";
  expect(kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).toMatchObject({
    passed: null, details: { status: "unavailable", diagnosticProtocol: { collection: "Default" } },
  });
  expect(kernelProfileVerdict(f.value, f.candidate, "pytorch", f.expected)).not.toHaveProperty("score");
});
