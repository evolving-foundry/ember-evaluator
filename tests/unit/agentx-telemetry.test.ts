import { expect, test } from "vitest";
import { normalizeTelemetry, parseTelemetry, parseTelemetryConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import { normalizeAgentXExport, parseAgentXSummary } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { renderAgentXTables } from "../../src/plugins/reporters/agentx-tables.js";
import { serverMetricsEvidence, telemetryConfig } from "../fixtures/agentx/server-metrics.js";
import { profileExport, workload, lexicon } from "../fixtures/agentx/export.js";

test("telemetry is opt-in and validates endpoints and device identity without I/O", () => {
  expect(parseAgentXReplayConfig({}).telemetry).toBeUndefined();
  expect(parseAgentXReplayConfig({ telemetry: telemetryConfig }).telemetry).toEqual(telemetryConfig);
  expect(parseAgentXReplayConfig({ telemetry: { vllm: { endpoint: "http://localhost:8000/" } } }).telemetry?.vllm?.endpoint).toBe("http://localhost:8000/metrics");
  for (const telemetry of [{}, { gpu: {} }, { vllm: { endpoint: "https://secret@example.com/metrics" } },
    { vllm: { endpoint: "https://example.com/metrics?token=secret" } }, { ascend: { endpoint: "http://x/metrics", deviceId: -1, chipId: 0 } },
    { ascend: { endpoint: "http://x/metrics", deviceId: 4 } }, { vllm: { endpoint: "file:///metrics" } }])
    expect(() => parseAgentXReplayConfig({ telemetry })).toThrow();
});

test("keeps upstream counter deltas, phase statistics, labels and exact windows", () => {
  const telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence());
  expect(telemetry.sources.map(s => s.status)).toEqual(["complete", "complete"]);
  expect(telemetry.sources[0]).toMatchObject({ samples: 30, warmupSamples: 3, window: { startNs: "1000000000", endNs: "11000000000" } });
  expect(telemetry.sources[0]?.series.find(s => s.metric === "vllm:prefix_cache_hits")).toMatchObject({ total: 75, rate: 7.5, mean: null });
  expect(telemetry.sources[0]?.warmupSeries[0]?.mean).toBe(0.01);
  expect(parseTelemetry(telemetry)).toEqual(telemetry);
  const summary = { ...normalizeAgentXExport(profileExport(), workload, lexicon), telemetry };
  expect(parseAgentXSummary(summary)).toEqual(summary);
  const report = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: summary }] }).join("\n");
  expect(report).toContain("物理 NPU 4 / chip 0");
  expect(report).toContain("0.75");
  expect(report).toContain("指定设备与芯片的观察值");
});

test("unavailable exports and missing profiling samples preserve the session result", () => {
  expect(normalizeTelemetry(telemetryConfig, "fixture-model", null).sources.every(s => s.status === "unavailable")).toBe(true);
  const evidence = { ...serverMetricsEvidence(), export: { ...serverMetricsEvidence().export, evaluator_collection_error_count: 5 } };
  for (const sample of Object.values(evidence.samples)) sample.profiling = 0;
  const telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", evidence);
  expect(telemetry.sources.every(s => s.status !== "complete")).toBe(true);
  expect(telemetry.collectionErrors).toBe(5);
  const summary = { ...normalizeAgentXExport(profileExport(), workload, lexicon), telemetry };
  expect(parseAgentXSummary(summary).profiling.ttft?.mean).toBe(12);
  const report = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: summary }] }).join("\n");
  expect(report).toContain("No profiling samples");
  expect(report).not.toContain("联合验收");
});

test("transient collector failures are reported once without invalidating available endpoint statistics", () => {
  const evidence = { ...serverMetricsEvidence(), export: { ...serverMetricsEvidence().export, evaluator_collection_error_count: 5 } };
  const telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", evidence);
  expect(telemetry.collectionErrors).toBe(5);
  expect(telemetry.sources.every(source => source.status === "complete" && !source.errors.length)).toBe(true);
  expect(telemetry.sources.map(source => source.series)).toEqual(
    normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence()).sources.map(source => source.series));
  expect(parseTelemetry(telemetry)).toEqual(telemetry);
  const summary = { ...normalizeAgentXExport(profileExport(), workload, lexicon), telemetry };
  expect(parseAgentXSummary(summary)).toMatchObject({ upstreamSubmissionValid: true, comparable: true });
  const report = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: summary }] }).join("\n");
  expect(report).toContain("监控抓取失败次数：5");
  expect(report).not.toContain("联合验收");
  expect(report).not.toContain("5 collection errors");
});

test("saved telemetry validates diagnostic fields and preserves older partial results", () => {
  const telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence());
  for (const collectionErrors of [-1, 1.5, "5", Number.NaN])
    expect(() => parseTelemetry({ ...telemetry, collectionErrors })).toThrow();
  const source = telemetry.sources[0];
  if (!source) throw new Error("Missing fixture source");
  source.status = "partial";
  source.errors = ["Harness recorded 5 collection errors; endpoint attribution unavailable, completeness not confirmed"];
  expect(parseTelemetry(telemetry)).toEqual(telemetry);
  expect(() => parseTelemetry({ ...telemetry, sources: [{ ...source, warnings: [5] }] })).toThrow();
});

test("rejects cross-device, cross-model and malformed values without substituting zeros", () => {
  const evidence = serverMetricsEvidence();
  const npu = evidence.export.metrics.ascend_npu_utilization_percent;
  if (!npu) throw new Error("fixture");
  for (const s of npu.series) s.labels.device_id = "3";
  const telemetry = normalizeTelemetry(telemetryConfig, "other-model", evidence);
  expect(telemetry.sources.every(s => s.status !== "complete")).toBe(true);
  expect(telemetry.sources[1]?.series.some(s => s.metric === "ascend_npu_utilization_percent")).toBe(false);
  const invalid = serverMetricsEvidence();
  const stat = invalid.export.metrics["vllm:kv_cache_usage_perc"].series[0];
  if (stat) stat.stats.avg = Number.NaN;
  expect(normalizeTelemetry(telemetryConfig, "fixture-model", invalid).sources[0]?.status).toBe("unavailable");
  const saved = normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence());
  if (saved.sources[1]?.series[0]) saved.sources[1].series[0].labels.device_id = "7";
  expect(() => parseTelemetry(saved)).toThrow(/device labels/);
});

test("counter reset handling remains upstream-owned and zero queries produce no hit ratio", () => {
  const evidence = serverMetricsEvidence();
  // This is the upstream reset-aware increase, rather than the final lifetime value.
  const queries = evidence.export.metrics["vllm:prefix_cache_queries"].series[0];
  if (queries) queries.stats.total = 0;
  const telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", evidence);
  const summary = { ...normalizeAgentXExport(profileExport(), workload, lexicon), telemetry };
  const report = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: summary }] }).join("\n");
  expect(report).toMatch(/prefix cache 命中率.*\| ratio \| —/u);
  expect(report).not.toMatch(/NaN|Infinity/u);
});

test("local telemetry validates explicit devices without querying hardware", () => {
  const local = { ascend: { mode: "local", devices: [{ deviceId: 4 }, { deviceId: 5, chipId: 1 }] } };
  expect(parseTelemetryConfig(local)).toEqual(local);
  for (const ascend of [
    { mode: "local", devices: [] }, { mode: "local" },
    { mode: "local", devices: [{ deviceId: 4 }, { deviceId: 4, chipId: 1 }] },
    { mode: "local", devices: [{ deviceId: -1 }] }, { mode: "local", devices: [{ deviceId: 4, chipId: -1 }] },
    { mode: "local", devices: [{ deviceId: 4 }], endpoint: "http://localhost/metrics" },
    { mode: "local", devices: [{ deviceId: 4, other: 0 }] }, { mode: "unknown", endpoint: "http://localhost/metrics" },
  ]) expect(() => parseTelemetryConfig({ ascend })).toThrow();
});

function localEvidence() {
  const evidence = serverMetricsEvidence();
  const first = telemetryConfig.ascend.endpoint;
  const second = "http://127.0.0.1:18096/metrics";
  for (const [name, metric] of Object.entries(evidence.export.metrics)) {
    if (!name.startsWith("ascend_npu_") || metric.type !== "gauge") continue;
    const original = metric.series[0];
    if (!original) throw new Error("fixture");
    metric.series.push({ ...structuredClone(original), endpoint_url: second, labels: { ...original.labels, device_id: "5", chip_id: "1" } });
  }
  evidence.export.summary.endpoints_successful.push(second);
  evidence.samples[second] = { profiling: 20, warmup: 2 };
  return { ...evidence, localAscend: [
    { deviceId: 4, chipId: 0, endpoint: first, errors: [] as string[] },
    { deviceId: 5, chipId: 1, endpoint: second, errors: [] as string[] },
    { deviceId: 6, endpoint: null, errors: ["No compute chips found for selected NPU device"] },
  ] };
}

const localConfig = () => parseTelemetryConfig({ vllm: telemetryConfig.vllm, ascend: { mode: "local",
  devices: [{ deviceId: 4 }, { deviceId: 5, chipId: 1 }, { deviceId: 6 }] } });

test("v2 preserves per-chip metrics and discovery failures and still reads historical v1", () => {
  const telemetry = normalizeTelemetry(localConfig(), "fixture-model", localEvidence());
  expect(telemetry.schemaVersion).toBe(2);
  expect(telemetry.sources.map(source => source.status)).toEqual(["complete", "complete", "complete", "unavailable"]);
  expect(telemetry.sources[2]).toMatchObject({ deviceId: 5, chipId: 1, samples: 20 });
  expect(telemetry.sources[3]).toMatchObject({ deviceId: 6, endpoint: null, samples: 0, series: [] });
  expect(parseTelemetry(telemetry)).toEqual(telemetry);
  const legacy = { ...normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence()), schemaVersion: 1 };
  expect(parseTelemetry(legacy)).toEqual({ ...legacy, schemaVersion: 2 });
  expect(legacy.schemaVersion).toBe(1);
  const hardware = legacy.sources.find(source => source.kind === "ascend");
  expect(() => parseTelemetry({ ...legacy, sources: [hardware, { ...hardware, deviceId: 5 }] })).toThrow(/historical/);
  expect(() => parseTelemetry({ ...telemetry, schemaVersion: 1 })).toThrow();
  const failed = normalizeTelemetry(localConfig(), "fixture-model", null);
  expect(failed.sources).toHaveLength(4);
  expect(parseTelemetry(failed)).toEqual(failed);
});

test("local sampler warnings preserve available statistics without marking healthy sibling endpoints partial", () => {
  const evidence = localEvidence();
  evidence.localAscend[1]?.errors.push("npu-smi query timed out");
  const telemetry = normalizeTelemetry(localConfig(), "fixture-model", evidence);
  expect(telemetry.sources.map(source => source.status)).toEqual(["complete", "complete", "complete", "unavailable"]);
  expect(telemetry.sources[2]?.series).toHaveLength(7);
  expect(telemetry.sources[2]?.warnings).toEqual(["npu-smi query timed out"]);
  expect(telemetry.sources[2]?.errors).toEqual([]);
  expect(telemetry.sources[0]?.warnings).toBeUndefined();
  expect(parseTelemetry(telemetry)).toEqual(telemetry);
});

test("local bridge identities reject unselected devices, endpoints, duplicates and omissions", () => {
  for (const mutate of [
    (e: ReturnType<typeof localEvidence>) => { if (e.localAscend[0]) e.localAscend[0].deviceId = 9; },
    (e: ReturnType<typeof localEvidence>) => { if (e.localAscend[1]) e.localAscend[1].chipId = 0; },
    (e: ReturnType<typeof localEvidence>) => { if (e.localAscend[0]) e.localAscend[0].endpoint = "http://remote:123/metrics"; },
    (e: ReturnType<typeof localEvidence>) => { e.localAscend.pop(); },
    (e: ReturnType<typeof localEvidence>) => { if (e.localAscend[0]) e.localAscend.push(e.localAscend[0]); },
    (e: ReturnType<typeof localEvidence>) => { if (e.localAscend[1]) e.localAscend[1].endpoint = telemetryConfig.ascend.endpoint; },
  ]) {
    const evidence = localEvidence(); mutate(evidence);
    const result = normalizeTelemetry(localConfig(), "fixture-model", evidence);
    expect(result.sources[0]?.status).toBe("complete");
    expect(result.sources.slice(1).every(source => source.status === "unavailable" && source.endpoint === null)).toBe(true);
    expect(parseTelemetry(result)).toEqual(result);
  }
});

test("report separates per-chip availability and does not impose joint acceptance on single-source measurements", () => {
  const summary = { ...normalizeAgentXExport(profileExport(), workload, lexicon),
    telemetry: normalizeTelemetry(localConfig(), "fixture-model", localEvidence()) };
  const report = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: summary }] }).join("\n");
  expect(report).toContain("#### NPU 4 / chip 0");
  expect(report).toContain("#### NPU 5 / chip 1");
  expect(report).toContain("#### NPU 6 / chip 未发现");
  expect(report).toContain("未启动");
  expect(report).toContain("NPU partial");
  const vllmOnly = { ...summary, telemetry: normalizeTelemetry({ vllm: telemetryConfig.vllm }, "fixture-model", serverMetricsEvidence()) };
  const single = renderAgentXTables({ applicable: true, points: [{ taskId: "point", status: "completed", measurement: vllmOnly }] }).join("\n");
  expect(single).toContain("硬件指标未启用");
  expect(single).not.toContain("NPU");
  expect(single).not.toContain("联合验收");
});
