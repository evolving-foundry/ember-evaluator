import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { selectedRecords } from "./records.js";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function evidenceFiles(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" &&
    !path.includes("\\") && !/[\u0000-\u001f]/u.test(path) &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..")) : [];
}

function summarizeL2(value: JsonValue | undefined) {
  if (value === undefined || value === null) return null;
  const analysis = object(value);
  const strings = (value: JsonValue | undefined) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string") : [];
  const evidence = strings(analysis.evidence), unavailable = strings(analysis.unavailable);
  return { optimization: typeof analysis.l2_cache_optimization === "boolean" ? analysis.l2_cache_optimization : null,
    conclusion: typeof analysis.conclusion === "string" ? analysis.conclusion : "",
    evidence: evidence.slice(0, 3), evidenceCount: evidence.length,
    unavailable: unavailable.slice(0, 3), unavailableCount: unavailable.length };
}

/** 多 block 与重复采样仅展示范围；不假定各行可直接求平均。 */
function summarizeProfiling(value: JsonValue | undefined) {
  if (value === undefined || value === null) return null;
  const profile = object(value);
  const kernels = Array.isArray(profile.kernels) ? profile.kernels.map(value => {
    const kernel = object(value), blocks = object(kernel.metrics);
    const metadata = object(kernel.metadata);
    const original = metadata.outputPolicy === "kernel-original-f542-v1";
    const samples = Object.values(blocks).flatMap(block => Array.isArray(block) ? block : [block]).map(object);
    const names = [...new Set(samples.flatMap(sample => Object.keys(sample)))].filter(name =>
      samples.some(sample => typeof sample[name] === "number" || sample[name] === null ||
        (original && typeof sample[name] === "string"))).sort();
    const values = Object.fromEntries(names.map(name => {
      const finite = samples.flatMap(sample => typeof sample[name] === "number" && Number.isFinite(sample[name]) ? [sample[name]] : []);
      const textValues = original ? [...new Set(samples.flatMap(sample => typeof sample[name] === "string" ? [sample[name]] : []))] : [];
      return [name, { minimum: finite.length ? Math.min(...finite) : null,
        maximum: finite.length ? Math.max(...finite) : null, available: finite.length, total: samples.length,
        ...(textValues.length ? { textValues } : {}) }];
    }));
    return { name: typeof kernel.name === "string" ? kernel.name : "unknown",
      blockCount: Object.keys(blocks).length, sampleCount: samples.length, values,
      outputPolicy: typeof metadata.outputPolicy === "string" ? metadata.outputPolicy : null,
      upstreamCommit: typeof metadata.upstreamCommit === "string" ? metadata.upstreamCommit : null,
      selectedBlockId: typeof metadata.selectedBlockId === "string" || typeof metadata.selectedBlockId === "number"
        ? String(metadata.selectedBlockId) : original && Object.keys(blocks).length === 1 ? Object.keys(blocks)[0] ?? null : null,
      metricPrecision: typeof metadata.metricPrecision === "number" ? metadata.metricPrecision : null,
      rawMetricsJson: evidenceFiles([metadata.rawMetricsJson ?? null])[0] ?? null,
      originalResultJson: evidenceFiles([metadata.originalResultJson ?? null])[0] ?? null,
      resources: { ub: metadata.ub ?? null, vectorCores: metadata.vectorCores ?? null },
      l2CacheAnalysis: summarizeL2(original ? samples.find(sample => sample.l2_cache_analysis !== undefined)?.l2_cache_analysis
        : metadata.l2CacheAnalysis),
      artifacts: evidenceFiles(kernel.artifacts) };
  }) : [];
  const metadata = object(profile.metadata);
  return { status: profile.status === "completed" ? "completed" : "failed",
    error: typeof profile.error === "string" ? profile.error : "Invalid profiling summary",
    originalReturnedNone: metadata.originalReturnedNone === true,
    serializationConversions: Array.isArray(metadata.serializationConversions) ? metadata.serializationConversions.length : 0,
    kernels, artifacts: evidenceFiles(profile.artifacts) };
}

/** 只汇总正确且有完整测量的候选，覆盖率以全部所选任务为分母。 */
export class KernelMetrics implements Metrics {
  readonly name = "kernel";
  async compute(snapshot: ResultSnapshot) {
    const records = selectedRecords(snapshot);
    const rows = records.map(record => {
      const details = record.verdict?.details;
      const d = details && typeof details === "object" && !Array.isArray(details) ? details : {};
      const valid = isEvaluationComplete(record) && d.protocol === "kernel-v1";
      const speedup = valid && record.verdict?.passed === true && typeof d.speedup === "number" && Number.isFinite(d.speedup) && d.speedup > 0 ? d.speedup : null;
      const profiling = summarizeProfiling(d.profiling);
      const safeAttempt = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(record.key.attemptId) && !record.key.attemptId.endsWith(".");
      return { taskId: record.key.taskId, valid, passed: valid && record.verdict?.passed === true,
        referenceKind: d.referenceKind ?? null, status: d.status ?? record.executionStatus,
        referenceMs: speedup === null ? null : d.referenceMs ?? null,
        candidateMs: speedup === null ? null : d.candidateMs ?? null, speedup,
        profilingRequested: d.profilingRequested === true || profiling !== null, profiling,
        evidencePath: safeAttempt ? `tasks/${safeTaskKey(record.key.taskId)}/attempts/${record.key.attemptId}` : null };
    });
    const valid = rows.filter(r => r.valid).length, passed = rows.filter(r => r.passed).length;
    const speedups = rows.flatMap(r => r.speedup === null ? [] : [r.speedup]);
    const selected = snapshot.run.taskIds.length, faster = speedups.filter(s => s > 1).length;
    const profilingRequested = rows.filter(row => row.profilingRequested).length;
    const profiled = rows.filter(row => row.profiling?.status === "completed").length;
    const profilingErrors = rows.filter(row => row.profiling?.status === "failed").length;
    return { selected, valid, invalid: rows.length - valid, pending: selected - rows.length, passed, measured: speedups.length, faster,
      passRateValid: valid ? passed / valid : null, passCoverage: selected ? passed / selected : null,
      fasterCoverage: selected ? faster / selected : null,
      geometricMeanSpeedup: speedups.length ? Math.exp(speedups.reduce((sum, s) => sum + Math.log(s), 0) / speedups.length) : null,
      profilingRequested, profiled, profilingErrors, profilingUncollected: profilingRequested - profiled - profilingErrors,
      profilingCoverage: selected ? profiled / selected : null,
      rows };
  }
}
