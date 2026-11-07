import { expect, test } from "vitest";
import { parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import { parseNetworkLatencyConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/network-latency.js";
import { normalizeAgentXExport, parseAgentXSummary } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { workload, lexicon, profileExport, networkProfileExport } from "../fixtures/agentx/export.js";

const automatic = { mode: "automatic" as const, pingIntervalSeconds: 1 };
const manual = { mode: "manual" as const, meanMs: 4 };
const probes = { total: 3, successful: 3, failed: 0 };

test("network calibration is opt-in and accepts automatic or manual RTT without mixing their fields", () => {
  expect(parseAgentXReplayConfig({})).not.toHaveProperty("networkLatency");
  expect(parseAgentXReplayConfig({ networkLatency: { mode: "automatic" } }).networkLatency).toEqual(automatic);
  expect(parseNetworkLatencyConfig({ mode: "automatic", pingIntervalSeconds: 0.25 })).toEqual({ mode: "automatic", pingIntervalSeconds: 0.25 });
  expect(parseNetworkLatencyConfig(manual)).toEqual(manual);
  expect(parseNetworkLatencyConfig({ mode: "manual", meanMs: 0 })).toEqual({ mode: "manual", meanMs: 0 });
});

test.each([
  null, true, {}, { mode: "unknown" }, { mode: "automatic", meanMs: 1 },
  { mode: "automatic", pingIntervalSeconds: 0 }, { mode: "automatic", pingIntervalSeconds: -1 },
  { mode: "automatic", pingIntervalSeconds: "1" }, { mode: "automatic", pingIntervalSeconds: Infinity },
  { mode: "automatic", pingIntervalSeconds: null },
  { mode: "manual" }, { mode: "manual", pingIntervalSeconds: 1, meanMs: 4 },
  { mode: "manual", meanMs: -1 }, { mode: "manual", meanMs: "4" }, { mode: "manual", meanMs: NaN },
  { mode: "automatic", unknown: true },
])("invalid network calibration configuration fails before execution: %j", networkLatency => {
  expect(() => parseAgentXReplayConfig({ networkLatency })).toThrow(/networkLatency/u);
});

test("official RTT and adjusted distributions are retained separately from raw request and warmup metrics", () => {
  const raw = networkProfileExport();
  expect(normalizeAgentXExport(raw, workload, lexicon)).not.toHaveProperty("networkLatency");
  const summary = normalizeAgentXExport(raw, workload, lexicon, undefined, { config: automatic, probes });
  expect(summary.networkLatency).toMatchObject({ config: automatic, status: "complete", rttMs: 4, probes,
    adjusted: { ttft: { mean: 8.125, p95: 21 }, ttfo: { mean: 11 }, requestLatency: { mean: 896 } }, warnings: [] });
  expect(summary.profiling.ttft?.mean).toBe(12);
  expect(summary.profiling.ttfo?.mean).toBe(15);
  expect(summary.profiling.requestLatency?.mean).toBe(900);
  expect(summary.profiling.itl?.mean).toBe(8);
  expect(summary.profiling.totalThroughput?.mean).toBe(440);
  expect(summary.warmup.ttft?.mean).toBe(99999);
  expect(summary.comparable).toBe(true);
  expect(parseAgentXSummary(summary)).toEqual(summary);
});

test("manual RTT stores its source and does not claim to have performed TCP probes", () => {
  const summary = normalizeAgentXExport(networkProfileExport(), workload, lexicon, undefined, { config: manual });
  expect(summary.networkLatency).toMatchObject({ config: manual, status: "complete", probes: null, rttMs: 4 });
  expect(parseAgentXSummary(summary)).toEqual(summary);
});

test("partial or absent network evidence never replaces raw metrics or fails a completed measurement", () => {
  const partial = normalizeAgentXExport(networkProfileExport(), workload, lexicon, undefined,
    { config: automatic, probes: { total: 3, successful: 2, failed: 1 } });
  expect(partial.networkLatency?.status).toBe("partial");
  expect(partial.networkLatency?.warnings).toContain("RTT 探测失败 1 次");
  expect(partial.comparable).toBe(true);
  expect(parseAgentXSummary(partial)).toEqual(partial);
  expect(parseAgentXSummary({ ...partial, networkLatency: { ...partial.networkLatency, warnings: ["历史采样诊断"] } }).networkLatency?.warnings).toEqual(["历史采样诊断"]);
  const unavailable = normalizeAgentXExport(profileExport(), workload, lexicon, undefined,
    { config: automatic, probes: { total: 3, successful: 0, failed: 3 } });
  expect(unavailable.networkLatency).toMatchObject({ status: "unavailable", rttMs: null,
    adjusted: { ttft: null, ttfo: null, requestLatency: null } });
  expect(unavailable.profiling.ttft?.mean).toBe(12);
  expect(parseAgentXSummary(unavailable)).toEqual(unavailable);
  const missingProbes = normalizeAgentXExport(networkProfileExport(), workload, lexicon, undefined, { config: automatic });
  expect(missingProbes.networkLatency?.status).toBe("partial");
  const zero = normalizeAgentXExport(profileExport(), workload, lexicon, undefined, { config: { mode: "manual", meanMs: 0 } });
  expect(zero.networkLatency).toMatchObject({ status: "unavailable", rttMs: null });
  const missingMetric = normalizeAgentXExport({ ...networkProfileExport(), network_adjusted_request_latency: null }, workload, lexicon, undefined, { config: manual });
  expect(missingMetric.networkLatency?.status).toBe("partial");
  expect(missingMetric.networkLatency?.adjusted.requestLatency).toBeNull();
  const clamped = normalizeAgentXExport({ ...networkProfileExport(), network_adjusted_time_to_first_token: { unit: "ms", avg: 0 } }, workload, lexicon, undefined, { config: manual });
  expect(clamped.networkLatency?.adjusted.ttft?.mean).toBe(0);
  expect(clamped.networkLatency?.status).toBe("complete");
});

test("saved results reject corrupt network evidence and retain compatibility with absent optional TTFO", () => {
  const summary = normalizeAgentXExport(networkProfileExport(), workload, lexicon, undefined, { config: automatic, probes });
  const n = summary.networkLatency;
  if (!n) throw new Error("Missing fixture calibration");
  for (const changed of [
    { rttMs: -1 }, { rttMs: NaN }, { status: "unavailable" }, { warnings: [] , probes: { total: 3, successful: 1, failed: 1 } },
    { probes: { total: 3, successful: 2, failed: -1 } }, { probes: { total: 1.5, successful: 1.5, failed: 0 } },
    { adjusted: { ...n.adjusted, ttft: { ...n.adjusted.ttft, unit: "sec" } } },
    { config: manual },
    { warnings: "not-an-array" }, { warnings: [1] },
  ]) expect(() => parseAgentXSummary({ ...summary, networkLatency: { ...n, ...changed } })).toThrow();
  const legacy = normalizeAgentXExport(profileExport(), workload, lexicon);
  delete legacy.profiling.ttfo;
  delete legacy.warmup.ttfo;
  expect(parseAgentXSummary(legacy).profiling.ttfo).toBeNull();
  expect(parseAgentXSummary(legacy)).not.toHaveProperty("networkLatency");
});
