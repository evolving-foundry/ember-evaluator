import { expect, test } from "vitest";
import { parseKernelContract, parseKernelAssessment } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { parseKernelManifest } from "../../src/plugins/benchmarks/operator/kernel/index.js";

const contract = { schemaVersion: 1, caseId: "fixed", inputs: [{ shape: [2, 4], dtype: "float16", contiguous: true }],
  output: { shape: [2, 2, 2], dtype: "float16", contiguous: true, independent: true }, inputUnmodified: true };
test("kernel manifest accepts and validates an explicit strict contract", () => {
  const task = { id: "t", problem: "p.py", candidate: "c.py", referenceKind: "pytorch", contract };
  expect(parseKernelManifest({ schemaVersion: 1, tasks: [task] })[0]?.contract).toEqual(contract);
  expect(() => parseKernelContract({ ...contract, output: { ...contract.output, shape: [0] } })).toThrow(/shape/);
  expect(() => parseKernelContract({ ...contract, unknown: true })).toThrow(/unknown/i);
});
test("strict assessment rejects missing checks and unknown check states", () => {
  expect(() => parseKernelAssessment({ schemaVersion: 1, checks: [] }, parseKernelContract(contract), [42])).toThrow();
});

import { kernelContractDigest, KERNEL_CHECK_IDS } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
const parsed = parseKernelContract(contract);
const assessment = () => ({ schemaVersion: 1, contractSha256: kernelContractDigest(parsed),
  checks: [0, 1].flatMap(call => KERNEL_CHECK_IDS.map(id => ({ id, seed: 42, call, status: "passed", message: "" }))),
  effectiveProtocol: { seeds: [42], rtol: 0, atol: 0, warmup: 5, repeat: 20, timingScope: "all-device-kernels", aggregation: "iteration-mean", timingSeed: 42 },
  environment: { python: "fixture", torch: "fixture", torchNpu: "fixture", triton: "fixture", cann: "fixture", driver: "fixture", device: "fixture", visibleDevices: "0" }, errorOwnership: null });
test("strict assessment requires complete unique per-seed and per-call evidence", () => {
  expect(parseKernelAssessment(assessment(), parsed, [42]).checks).toHaveLength(16);
  const missing = assessment(); missing.checks.pop();
  expect(() => parseKernelAssessment(missing, parsed, [42])).toThrow(/Incomplete/);
  const duplicate = assessment(); duplicate.checks[1] = duplicate.checks[0]!;
  expect(() => parseKernelAssessment(duplicate, parsed, [42])).toThrow(/Duplicate/);
  expect(() => parseKernelAssessment(assessment(), parsed, [43])).toThrow();
  expect(() => parseKernelAssessment({ ...assessment(), contractSha256: "bad" }, parsed, [42])).toThrow(/identity/);
});
test("strict verdict refuses not-run checks and unattributed candidate defects", () => {
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: assessment() };
  expect(kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42]).passed).toBe(true);
  value.assessment.checks[0]!.status = "not-run";
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/Strict checks/);
  expect(() => kernelVerdict({ ...value, status: "candidate_error", referenceMs: null, candidateMs: null, speedup: null }, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/evidence/);
});


test("strict performance verdict requires the observed environment identity", () => {
  const checks = { ...assessment(), environment: { ...assessment().environment, driver: null } };
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: checks };
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/environment/);
});
