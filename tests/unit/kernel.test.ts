import { expect, test } from "vitest";
import { prefixProfilingPaths } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { parseKernelProfiling, kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { parseKernelConfig, parseKernelManifest } from "../../src/plugins/benchmarks/operator/kernel/index.js";
import { analyzeRoofline, DEFAULT_ROOFLINE_CONFIG } from "../../src/plugins/benchmarks/operator/kernel/roofline.js";
import { analyzeTraceEvents, getNpuSpecs, DEFAULT_NPU_DEVICE } from "../../src/plugins/benchmarks/operator/kernel/msprof-analysis.js";
import { renderKernelTables } from "../../src/plugins/reporters/kernel-tables.js";

test("prefixProfilingPaths rewrites artifacts and profileDir to verifier-relative", () => {
  const raw = { schemaVersion: 1, status: "completed", error: "",
    kernels: [{ name: "kernel_fn", metrics: {}, artifacts: ["profiling/x.csv"], metadata: { profileDir: "profiling/OPPROF_a" } }],
    metadata: { profileDir: "profiling/OPPROF_a", kernelCount: 1 }, artifacts: ["profiling/result.json"] };
  const out = prefixProfilingPaths(raw, "kernel-profile_profiling_root") as Record<string, any>;
  expect(out.artifacts).toEqual(["kernel-profile_profiling_root/profiling/result.json"]);
  expect(out.metadata.profileDir).toBe("kernel-profile_profiling_root/profiling/OPPROF_a");
  expect(out.metadata.kernelCount).toBe(1);
  expect(out.kernels[0].artifacts).toEqual(["kernel-profile_profiling_root/profiling/x.csv"]);
  expect(out.kernels[0].metadata.profileDir).toBe("kernel-profile_profiling_root/profiling/OPPROF_a");
  expect(parseKernelProfiling(out)).toStrictEqual(out);
});

const sha = "a".repeat(64);

test("parseKernelConfig applies defaults and rejects unknown fields", () => {
  const config = parseKernelConfig({ manifest: "tasks.yaml" });
  expect(config).toMatchObject({ manifest: "tasks.yaml", python: "python3", device: 0,
    seeds: [0, 1, 2], rtol: 0.001, atol: 0.001, warmup: 5, repeat: 20 });
  expect(config.profiling).toMatchObject({ enabled: false, attemptTimeoutSeconds: 300, maxAttempts: 2, roundNum: 1, cacheEnabled: true });
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", unknown: 1 })).toThrow(/kernel/);
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", seeds: [1, 1] })).toThrow(/unique/);
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", warmup: 0 })).toThrow(/warmup/);
});

test("parseKernelConfig derives timeout from profiling attempts", () => {
  const config = parseKernelConfig({ manifest: "m", profiling: { enabled: true, maxAttempts: 3, attemptTimeoutSeconds: 100 } });
  expect(config.timeoutSeconds).toBe(600);
  expect(config.profiling.enabled).toBe(true);
});

test("parseKernelManifest validates schema and relative files", () => {
  const manifest = parseKernelManifest({ schemaVersion: 1, tasks: [
    { id: "t1", problem: "p.py", candidate: "c.py", referenceKind: "pytorch", outputIndices: [0, 1] },
  ] });
  expect(manifest[0]).toMatchObject({ id: "t1", referenceKind: "pytorch" });
  expect(() => parseKernelManifest({ schemaVersion: 1, tasks: [
    { id: "t1", problem: "p.py", candidate: "c.py", referenceKind: "pytorch" },
    { id: "t1", problem: "p.py", candidate: "c.py", referenceKind: "pytorch" },
  ] })).toThrow(/Duplicate/);
  expect(() => parseKernelManifest({ schemaVersion: 1, tasks: [
    { id: "t1", problem: "p.py", candidate: "c.py", referenceKind: "onnx" },
  ] })).toThrow(/referenceKind/);
  expect(() => parseKernelManifest({ schemaVersion: 1, tasks: [
    { id: "t1", problem: "../escape.py", candidate: "c.py", referenceKind: "pytorch" },
  ] })).toThrow(/relative file/);
});

const validProfiling = {
  schemaVersion: 1, status: "completed", error: "",
  kernels: [{ name: "kernel0", metrics: { aiv_vec_ratio: 0.5 } }],
  metadata: { rawMetricsJson: "profiling/raw-metrics.json" },
  artifacts: ["profiling/raw-metrics.json", "profiling/metrics-dataframe.csv"],
};

test("parseKernelProfiling rejects traversal and absolute artifact paths", () => {
  expect(parseKernelProfiling(validProfiling)).toBeTruthy();
  for (const bad of [["../out.json", "x"], ["/abs/path.json", "x"], ["a\\b.json", "x"]]) {
    expect(() => parseKernelProfiling({ ...validProfiling, artifacts: bad })).toThrow(/verifier-relative/);
  }
  expect(() => parseKernelProfiling({ ...validProfiling, schemaVersion: 2 })).toThrow(/identity/);
  expect(() => parseKernelProfiling({ ...validProfiling, kernels: "no" })).toThrow(/evidence/);
});

test("kernelVerdict accepts consistent passed timing and rejects mismatches", () => {
  const payload = { schemaVersion: 1, candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "passed", error: "",
    referenceMs: 0.1, candidateMs: 0.05, speedup: 2, profiling: validProfiling };
  const verdict = kernelVerdict(payload, sha, "pytorch", true);
  expect(verdict.passed).toBe(true);
  expect(verdict.score).toBe(1);
  const details = verdict.details as Record<string, unknown>;
  expect(details.protocol).toBe("kernel-v1");
  expect(details.speedup).toBe(2);
  // Reject speedup values that do not match the measured timings.
  expect(() => kernelVerdict({ ...payload, speedup: 3 }, sha, "pytorch")).toThrow(/Inconsistent/);
  // Reject zero, negative and nonfinite measurements.
  expect(() => kernelVerdict({ ...payload, candidateMs: 0 }, sha, "pytorch")).toThrow(/Invalid kernel measurement/);
});

test("kernelVerdict rejects failed results carrying scores and maps infra errors", () => {
  // Reject timing scores on failed results, including omitted fields (undefined !== null).
  const base = { schemaVersion: 1, candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "incorrect", error: "mismatch",
    referenceMs: null, candidateMs: null, speedup: null };
  expect(() => kernelVerdict({ ...base, referenceMs: 0.1, candidateMs: 0.05, speedup: 2 }, sha, "pytorch"))
    .toThrow(/must not carry timing scores/);
  const failed = kernelVerdict(base, sha, "pytorch");
  expect(failed).toMatchObject({ passed: false, score: 0 });
  expect(() => kernelVerdict({ ...base, status: "infrastructure_error" }, sha, "pytorch")).toThrow(/infrastructure/);
  // Reject candidate SHA mismatches.
  expect(() => kernelVerdict({ ...base, status: "passed", referenceMs: 0.1, candidateMs: 0.05, speedup: 2 }, "b".repeat(64), "pytorch")).toThrow(/identity/);
});

test("kernelVerdict adapts unparseable profiling instead of failing the run", () => {
  const payload = { schemaVersion: 1, candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "passed", error: "",
    referenceMs: 0.1, candidateMs: 0.1, speedup: 1, profiling: { schemaVersion: 1 } };
  const verdict = kernelVerdict(payload, sha, "pytorch");
  const profiling = (verdict.details as Record<string, unknown>).profiling as Record<string, unknown>;
  expect(profiling.status).toBe("failed");
  expect(profiling.metadata).toMatchObject({ adapterError: true });
});

test("roofline picks the busiest pipe with underutilized priority", () => {
  const row = { aiv_scalar_ratio: 0.2, aiv_vec_ratio: 0.9, aiv_mte2_ratio: 0.3, aiv_mte3_ratio: 0.1, aiv_vec_time: 10 };
  const result = analyzeRoofline({ block0: row });
  expect(result.bottleneck).toBe("vec");
  expect(result.vec_rate).toBeCloseTo(0.9);
  expect(result.at_roofline).toBe(false);
  // Prefer underutilized ("no") when maximum utilization is below its threshold.
  const low = analyzeRoofline({ block0: { ...row, aiv_vec_ratio: 0.5 } });
  expect(low.bottleneck).toBe("no");
  expect(low.vec_rate).toBeCloseTo(0.5);
  // Apply the underutilized (0.8) gate before classifying pipeline bounds (0.4).
  const mid = analyzeRoofline({ block0: { ...row, aiv_vec_ratio: 0.9, aiv_scalar_ratio: 0.85 } });
  expect(mid.bottleneck).toBe("vec");
  // Warn on empty tables without throwing.
  expect(analyzeRoofline({}).warnings).toContain("Empty msprof_metrics");
});

test("npu specs lookup falls back to the default device", () => {
  expect(getNpuSpecs(DEFAULT_NPU_DEVICE)?.vector_count).toBe(56);
  expect(getNpuSpecs("UNKNOWN CHIP")).toBeNull();
});

test("renderKernelTables renders rows and hides metrics summary", () => {
  expect(renderKernelTables(undefined)).toEqual([]);
  const metric = { selected: 1, passed: 1, valid: 1, measured: 1, faster: 1, geometricMeanSpeedup: 2,
    rows: [{ taskId: "t1", valid: true, passed: true, referenceKind: "pytorch",
      referenceMs: 0.1, candidateMs: 0.05, speedup: 2, profilingRequested: false, profiling: null,
      evidencePath: "tasks/t1/attempts/a1" }] };
  const text = renderKernelTables(metric, "http://e/").join("\n");
  expect(text).toContain("## \u7b97\u5b50\u6b63\u786e\u6027\u4e0e\u6027\u80fd");
  expect(text).toContain("| t1 | true / true | pytorch | 0.1 | 0.05 | 2 |");
  expect(text).toContain("result.json");
});

test("analyzeTraceEvents ports the original trace analyzer semantics", () => {
  // Select core4, which has the longer span; the longest MTE2 duration indicates memory_bound_candidate.
  // MTE2 and VECTOR do not overlap; double buffering has no cross-iteration overlap and is ineffective.
  const ev = (pid: string, tid: string, ts: number, dur: number) => ({ pid, tid, ts, dur });
  const events = [
    ev("core3", "MTE2", 0, 10), ev("core3", "VECTOR", 0, 8),
    ev("core4.veccore1", "MTE2", 0, 20), ev("core4.veccore1", "MTE2", 30, 21),
    ev("core4.veccore1", "VECTOR", 25, 5), ev("core4.veccore1", "VECTOR", 55, 5),
    ev("core4.veccore1", "MTE3", 60, 4),
  ];
  const r = analyzeTraceEvents(events)!;
  expect(r.longest_core).toBe("core4.veccore1");
  expect(r.core_span_us).toBe(64);
  expect(r.bound.type).toBe("memory_bound_candidate");
  expect(r.bound.evidence).toBe("MTE2 has the largest trace duration (41.000000 us)");
  expect(r.pipeline.compute).toBe("VECTOR");
  expect(r.pipeline.mte2_compute_overlap_percent).toBe(0);
  expect(r.pipeline.pipeline_parallel).toBe(false);
  expect(r.double_buffer.status).toBe("ineffective_or_not_enabled");
  expect(r.double_buffer.comparable_rounds).toBe(1);
  expect(r.optimization_feedback).toEqual([
    "optimize data movement and improve data reuse", "check or enable Double Buffer"]);
  expect(r.bubble.mte2).toEqual({ count: 1, total_us: 10, max_us: 10 });
  // Return null for empty, non-array or kernel-free event inputs.
  expect(analyzeTraceEvents([])).toBeNull();
  expect(analyzeTraceEvents(undefined)).toBeNull();
  expect(analyzeTraceEvents([{ pid: "c", ts: 1, dur: 2 }])).toBeNull();
});

test("kernel atom --device parses card id and rejects invalid values", async () => {
  const { parseArgs } = await import("../../src/cli.js");
  expect(parseArgs(["kernel", "bench", "--problem", "p.py", "--kernel", "k.py", "--out", "o.json", "--device", "2"]))
    .toMatchObject({ kind: "kernel-bench", device: 2 });
  expect(parseArgs(["kernel", "profile", "--problem", "p.py", "--kernel", "k.py", "--out", "o.json"]))
    .toMatchObject({ kind: "kernel-profile", device: 0 });
  expect(() => parseArgs(["kernel", "precision", "--problem", "p.py", "--kernel", "k.py",
    "--out", "o.json", "--device", "-1"])).toThrow(/non-negative/);
  expect(() => parseArgs(["kernel", "bench", "--problem", "p.py", "--kernel", "k.py",
    "--out", "o.json", "--device", "x"])).toThrow(/non-negative/);
});


test("profile CLI forwards replay seed and warmup through the current command parser", async () => {
  const { parseArgs } = await import("../../src/cli.js");
  const base = ["kernel", "profile", "--problem", "p.py", "--kernel", "k.py", "--out", "o.json"];
  expect(parseArgs(base)).toMatchObject({ kind: "kernel-profile", seed: 0, warmup: 25 });
  expect(parseArgs([...base, "--seed", "42", "--warmup", "7"]))
    .toMatchObject({ kind: "kernel-profile", seed: 42, warmup: 7 });
  expect(() => parseArgs([...base, "--seed", "-1"])).toThrow(/non-negative/);
});
