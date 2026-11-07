import { parseKernelTimingEvidence } from "./timing.js";
import { expectNonEmptyString, expectRecord } from "../../../../core/validation/input.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../core/contracts/result.js";
import { parseKernelAssessment, type KernelContract } from "./strict.js";
import { isAbsolute, posix } from "node:path";

function finiteJson(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => finiteJson(item, `${label}[${index}]`));
  const record = expectRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, finiteJson(item, `${label}.${key}`)]));
}

function artifactPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Missing profiling artifacts");
  return value.map(artifact => {
    const path = expectNonEmptyString(artifact, "profiling.artifact");
    if (isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f]/u.test(path) ||
        path.split("/").some(part => part === ".." || part === "." || !part) || posix.normalize(path) !== path)
      throw new TypeError("Profiling artifact must be a verifier-relative file without traversal");
    return path;
  });
}

function metadataPaths(metadata: Record<string, unknown>): void {
  for (const name of ["rawMetricsJson", "originalResultJson", "metricsDataframeCsv", "profileDir"])
    if (metadata[name] !== undefined) artifactPaths([metadata[name]]);
}

/** Validate the framework boundary; the profiler determines status, field availability and metric values. */
export function parseKernelProfiling(value: unknown): { [key: string]: JsonValue } {
  const p = expectRecord(value, "kernel profiling");
  if (p.schemaVersion !== 1 || (p.status !== "completed" && p.status !== "failed") || typeof p.error !== "string")
    throw new TypeError("Invalid kernel profiling identity");
  if (!Array.isArray(p.kernels) || !Array.isArray(p.artifacts)) throw new TypeError("Missing kernel profiling evidence");
  metadataPaths(expectRecord(p.metadata, "profiling.metadata"));
  artifactPaths(p.artifacts);
  for (const value of p.kernels) {
    const kernel = expectRecord(value, "profiled kernel");
    expectNonEmptyString(kernel.name, "profiled kernel.name");
    expectRecord(kernel.metrics, "profiled kernel.metrics");
    if (kernel.artifacts !== undefined) artifactPaths(kernel.artifacts);
    const metadata = kernel.metadata === undefined ? {} : expectRecord(kernel.metadata, "profiled kernel.metadata");
    metadataPaths(metadata);
  }
  const result = finiteJson(p, "profiling");
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError("Invalid profiling object");
  return result;
}

/** Accept only complete, finite positive timings; infrastructure errors do not become candidate zero scores. */
export function kernelVerdict(value: unknown, candidateSha256: string, referenceKind: string, profilingRequested = false, contract?: KernelContract, seeds: number[] = []): VerifyResult {
  const r = expectRecord(value, "kernel result");
  if (r.schemaVersion !== 1 || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "all-device-kernels" || typeof r.error !== "string") throw new Error("Invalid kernel result identity");
  const details: { [key: string]: JsonValue } = { protocol: "kernel-v1", candidateSha256, referenceKind,
    timingScope: "all-device-kernels", status: typeof r.status === "string" ? r.status : "invalid", error: r.error,
    referenceMs: null, candidateMs: null, speedup: null,
    ...(profilingRequested ? { profilingRequested: true } : {}) };
  if (contract !== undefined) {
    const assessment = parseKernelAssessment(r.assessment, contract, seeds);
    details.assessment = finiteJson(assessment, "assessment");
    if (r.status === "passed" && (assessment.errorOwnership !== null || assessment.checks.some(c => c.status !== "passed")))
      throw new VerificationError("Strict checks did not pass", details);
    if (r.status === "passed" && Object.values(assessment.environment).some(value => value === null))
      throw new VerificationError("Strict measurement environment identity unavailable", details);
    if ((r.status === "incorrect" || r.status === "candidate_error") &&
      (assessment.errorOwnership !== "candidate" || !assessment.checks.some(c => c.status === "failed")))
      throw new VerificationError("Candidate failure lacks strict evidence", details);
  }
  if (r.profiling !== undefined) {
    try { details.profiling = parseKernelProfiling(r.profiling); }
    catch {
      // Do not copy unvalidated objects or exception messages into reports as unsafe evidence paths.
      details.profiling = { schemaVersion: 1, status: "failed", error: "Profiling result could not be adapted",
        kernels: [], metadata: { adapterError: true }, artifacts: [] };
    }
  } else if (profilingRequested && r.status === "passed") {
    details.profiling = { schemaVersion: 1, status: "failed", error: "Requested profiling did not return a result",
      kernels: [], metadata: { missingResult: true }, artifacts: [] };
  }
  if (r.status === "infrastructure_error") throw new VerificationError("Kernel evaluation infrastructure failed", details);
  if (r.status === "incorrect" || r.status === "candidate_error") {
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null) throw new Error("Failed kernel must not carry timing scores");
    return { passed: false, score: 0, details };
  }
  if (r.status !== "passed") throw new Error("Unknown kernel evaluation status");
  for (const name of ["referenceMs", "candidateMs", "speedup"] as const) {
    const measured = r[name];
    if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0)
      throw new VerificationError(`Invalid kernel measurement: ${name}`, details);
    details[name] = measured;
  }
  if (r.timingEvidence !== undefined) {
    const timing = parseKernelTimingEvidence(r.timingEvidence);
    if (Math.abs(timing.reference.meanMs - Number(r.referenceMs)) > 1e-12 || Math.abs(timing.candidate.meanMs - Number(r.candidateMs)) > 1e-12)
      throw new VerificationError("Timing evidence mean mismatch", details);
    details.timingEvidence = finiteJson(timing, "timing evidence");
  }
  const reference = details.referenceMs as number, candidate = details.candidateMs as number, speedup = details.speedup as number;
  if (Math.abs(reference / candidate - speedup) > 1e-8 * Math.max(1, speedup)) throw new Error("Inconsistent kernel speedup");
  return { passed: true, score: 1, details };
}

/** Validate independent capture receipts at the Benchmark boundary before publishing a diagnostic verdict. */
export function kernelProfileVerdict(value: unknown, candidateSha256: string, referenceKind: string, expected: {
  caseId: string; seed: number; warmup: number; collection: "Default" | "PipeTimeline,Default";
  problemSha256: string; contractSha256?: string;
}): VerifyResult {
  const profiling = parseKernelProfiling(expectRecord(value, "kernel result").profiling);
  const metadata = expectRecord(profiling.metadata, "profile metadata");
  const protocol = { caseId: expected.caseId, seeds: [expected.seed], warmup: expected.warmup,
    collection: expected.collection, scope: "original-first-triton-kernel-or-file-stem",
    capture: "after-warmup-mstx-range", selectionPolicy: "last" };
  if (profiling.status === "completed") {
    const actual = expectRecord(metadata.diagnosticProtocol, "diagnosticProtocol");
    if (Object.entries(protocol).some(([name, value]) => JSON.stringify(actual[name]) !== JSON.stringify(value)) || metadata.collection !== expected.collection)
      throw new VerificationError("Diagnostic effective protocol mismatch", {});
    const trace = expectRecord(metadata.trace, "diagnostic trace");
    if (expected.collection === "Default" ? trace.status !== "unavailable" || trace.reason !== "not-requested-by-default-protocol" : trace.status !== "available")
      throw new VerificationError("Diagnostic trace availability mismatch", {});
    const sources = expectRecord(metadata.sources, "diagnostic sources");
    if (expectRecord(sources.candidate, "candidate source").sha256 !== candidateSha256 ||
        expectRecord(sources.problem, "problem source").sha256 !== expected.problemSha256)
      throw new VerificationError("Diagnostic native source mismatch", {});
    const replay = expectRecord(metadata.replay, "diagnostic replay");
    if (replay.seed !== expected.seed || replay.warmup !== expected.warmup || replay.logicalDevice !== 0)
      throw new VerificationError("Diagnostic replay protocol mismatch", {});
  }
  return { passed: null, details: { protocol: "kernel-profile/v1", operation: "profile", candidateSha256, referenceKind,
    status: profiling.status === "completed" ? "completed" : "unavailable", cleanup: "confirmed",
    diagnosticProtocol: protocol, profiling,
    ...(expected.contractSha256 === undefined ? {} : { contractSha256: expected.contractSha256 }) } };
}
