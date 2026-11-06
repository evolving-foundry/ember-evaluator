import { expect, test } from "vitest";
import { normalizeAgentXExport, parseAgentXSummary, parseWorkload, agentXUsage } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { parseAgentXConfig, AgentXBenchmark } from "../../src/plugins/benchmarks/inference-engine/agentx/agentx-benchmark.js";
import { agentXEndpoint, parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import { readProfileDirectory } from "../../src/infrastructure/profiles/read.js";
import { resolveInput } from "../../src/config/resolve.js";
import { assertAttemptRecord, assertVerifyResult } from "../../src/core/results/record-validation.js";
import { finalizeAttemptOutcome, evaluationScore, isEvaluationComplete } from "../../src/core/results/evaluation-outcome.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { HarborScoreMetrics } from "../../src/plugins/metrics/harbor-score.js";
import { AgentXPerformanceMetrics } from "../../src/plugins/metrics/agentx-performance.js";
import { renderMarkdown } from "../../src/plugins/reporters/markdown.js";
import type { EffectiveConfig } from "../../src/core/contracts/config.js";
import type { ResultSnapshot } from "../../src/core/contracts/result.js";
import { storeRecord, storeRun } from "../fixtures/results/store-fixture.js";
import { workload, lexicon, profileExport } from "../fixtures/agentx/export.js";

function snapshot(): ResultSnapshot {
  const summary = normalizeAgentXExport(profileExport(), workload, lexicon);
  const record = storeRecord({ runId: "run-1", taskId: "point-1", attemptId: "attempt-1" });
  record.evaluationKind = "performance";
  record.verdict = { passed: null, details: {} };
  if (record.solve) record.solve.observations = summary;
  finalizeAttemptOutcome(record);
  return { run: { ...storeRun, evaluationKind: "performance", taskIds: ["point-1"], status: "completed",
    source: { source: "fixture", revision: workload.revision, files: [{ path: "traces.jsonl", sha256: workload.sha256, origin: "https://fixture.invalid/traces" }], metadata: {} } },
    records: [record], pendingTaskIds: [], digest: "snapshot" };
}

test("AgentX profile exposes standard and replay, and rejects the removed smoke scenario", async () => {
  const profiles = await readProfileDirectory(new URL("../../src/plugins/benchmarks/inference-engine/profiles/", import.meta.url));
  const source = { services: { default: { model: "fixture/model", base_url: "http://localhost:8000/v1" } }, benchmark: { name: "agentx" } };
  const standard = resolveInput("experiment.yaml", source, profiles).source;
  expect(standard.solver).toMatchObject({ name: "agentx-replay" });
  expect(standard.scheduler).toEqual({ name: "local", config: { concurrency: 1 } });
  expect(standard.metrics).toEqual(expect.arrayContaining([{ name: "agentx-performance", config: {} }]));
  expect(standard.run).toMatchObject({ timeoutSeconds: 10800, preparation: { mode: "batch", concurrency: 1 } });
  expect(Object.keys(profiles.find(profile => profile.id === "agentx")?.scenarios ?? {})).toEqual(["standard", "replay"]);
  expect(() => resolveInput("experiment.yaml", { ...source, benchmark: { name: "agentx", scenario: "smoke" } }, profiles)).toThrow(/scenario/iu);
  const replay = resolveInput("experiment.yaml", { ...source, benchmark: { name: "agentx", scenario: "replay", config: { traceCount: 50 } } }, profiles).source;
  expect(replay.benchmark).toMatchObject({ config: { mode: "replay", durationSeconds: 86400, traceCount: 50 } });
  expect(replay.run).toMatchObject({ timeoutSeconds: 172800, preparation: { mode: "batch", concurrency: 1 } });
});

test.each([{ concurrency: [] }, { concurrency: [1, 1] }, { concurrency: [0] }, { durationSeconds: 0 }, { durationSeconds: -1 }, { durationSeconds: 1.5 }, { durationSeconds: "60" }, { seed: 1 }, { variant: "32k" }, { unknown: true }])(
  "rejects invalid or nonstandard AgentX configuration: %j", value => expect(() => parseAgentXConfig(value)).toThrow());

test("standard defaults, replay settings and endpoint paths are explicit, and smoke config is rejected", () => {
  expect(parseAgentXConfig({})).toMatchObject({ mode: "standard", variant: "256k", concurrency: [1], durationSeconds: 3600, seed: 42 });
  expect(() => parseAgentXConfig({ mode: "smoke" })).toThrow("agentx.mode must be standard or replay");
  expect(parseAgentXReplayConfig({}).trustRemoteCode).toBe(false);
  expect(() => parseAgentXReplayConfig({ maxTokens: 10 })).toThrow();
  expect(agentXEndpoint("http://localhost:8000")).toEqual({ url: "http://localhost:8000", endpoint: "/v1/chat/completions" });
  expect(agentXEndpoint("https://example.com/router/v1/").endpoint).toBe("/router/v1/chat/completions");
  expect(agentXEndpoint("https://example.com/v1/chat/completions").endpoint).toBe("/v1/chat/completions");
  expect(() => agentXEndpoint("https://secret@example.com/v1")).toThrow();
});

test.each([1, 60, 900, 3600, 7200])("standard accepts a %s-second window and preserves it in saved observations", durationSeconds => {
  expect(parseAgentXConfig({ durationSeconds })).toMatchObject({ mode: "standard", durationSeconds, seed: 42 });
  const custom = parseWorkload({ ...workload, durationSeconds });
  const summary = normalizeAgentXExport(profileExport(), custom, lexicon);
  expect(parseAgentXSummary(summary)).toEqual(summary);
  expect(summary.workload.durationSeconds).toBe(durationSeconds);
  expect(summary.upstreamSubmissionValid).toBe(true);
  expect(summary.comparable).toBe(durationSeconds === 3600);
  expect(summary.incomparableReasons).toEqual(durationSeconds === 3600 ? [] : ["custom_duration"]);
  if (durationSeconds !== 3600)
    expect(() => parseAgentXSummary({ ...summary, comparable: true, incomparableReasons: [] })).toThrow(/comparability/u);
});

test("full replay requires a finite trace selection and rejects incomplete coverage", () => {
  expect(parseAgentXConfig({ mode: "replay", traceCount: 50, concurrency: [8] })).toMatchObject({ mode: "replay", traceCount: 50, durationSeconds: 86400 });
  for (const config of [{ mode: "replay" }, { mode: "replay", traceCount: 0 }, { mode: "replay", traceCount: 1, concurrency: [2] }, { traceCount: 50 }, { mode: "smoke", traceCount: 50 }])
    expect(() => parseAgentXConfig(config)).toThrow();
  const replay = parseWorkload({ ...workload, mode: "replay", traceCount: 2 });
  const coverage = { schemaVersion: 1, selectedTraces: 2, completedTraces: 2, expectedRequests: 120, observedRequests: 120,
    successfulRequests: 120, failedRequests: 0, cancelledRequests: 0, missingRequests: 0, duplicateRequests: 0, unexpectedRequests: 0, complete: true };
  const summary = normalizeAgentXExport(profileExport(), replay, lexicon, coverage);
  expect(parseAgentXSummary(summary)).toEqual(summary);
  expect(summary.comparable).toBe(false);
  expect(summary.incomparableReasons).toContain("full_trace_replay");
  expect(() => normalizeAgentXExport(profileExport(), replay, lexicon)).toThrow();
  for (const changed of [{ complete: false }, { missingRequests: 1 }, { duplicateRequests: 1 }, { unexpectedRequests: 1 },
    { cancelledRequests: 1 }, { observedRequests: 119 }, { completedTraces: 1 }, { selectedTraces: 3 }])
    expect(() => parseAgentXSummary({ ...summary, replayCoverage: { ...coverage, ...changed } })).toThrow();
});

test("cross-component validation rejects collisions, unsupported execution and short budgets", () => {
  const benchmark = new AgentXBenchmark(parseAgentXConfig({}), "local");
  const config: EffectiveConfig = { services: { default: { name: "fixture", endpoint: "http://localhost:8000", api: "openai-completions", provider: null } },
    benchmark: { name: "agentx", config: {} }, solver: { name: "agentx-replay", config: {}, service: "default" },
    environment: { name: "local", config: {} }, scheduler: { name: "local", config: { concurrency: 1 } },
    metrics: [], reporter: { name: "markdown", config: {} }, store: { name: "local", config: {} },
    run: { maxTasks: null, taskIds: null, timeoutSeconds: 10800, }, output: { directory: ".scratch" } };
  expect(() => benchmark.validateRun(config)).not.toThrow();
  for (const mutate of [
    (c: EffectiveConfig) => { c.solver.name = "simpleagent"; },
    (c: EffectiveConfig) => { c.scheduler.config.concurrency = 2; },
    (c: EffectiveConfig) => { c.scheduler.name = "ray"; },
    (c: EffectiveConfig) => { c.run.timeoutSeconds = 300; },
    (c: EffectiveConfig) => { if (c.services.default) c.services.default.maxTokens = 100; },
  ]) { const changed = structuredClone(config); mutate(changed); expect(() => benchmark.validateRun(changed)).toThrow(); }
  const docker = structuredClone(config);
  docker.environment.name = "docker";
  docker.solver.config.telemetry = { ascend: { mode: "local", devices: [{ deviceId: 4 }] } };
  expect(() => benchmark.validateRun(docker)).not.toThrow();
});

test("profiling is isolated from warmup and preserves upstream distributions and actual rates", () => {
  const summary = normalizeAgentXExport(profileExport(), workload, lexicon);
  expect(summary.profiling.ttft).toMatchObject({ mean: 12, p95: 25, count: 120 });
  expect(summary.warmup.ttft?.mean).toBe(99999);
  expect(summary.profiling.totalThroughput?.mean).toBe(440);
  expect(summary.profiling.fullResponseInteractivity).toBeNull();
  expect(summary.comparable).toBe(true);
  expect(parseAgentXSummary(summary)).toEqual(summary);
  expect(agentXUsage(summary)).toEqual({ inputTokens: 1441000, outputTokens: 144100, totalTokens: 1585100 });
  const smoke = normalizeAgentXExport(profileExport(), { ...workload, mode: "smoke", durationSeconds: 60 }, lexicon);
  expect(parseAgentXSummary(smoke)).toEqual(smoke);
  expect(smoke.upstreamSubmissionValid).toBe(true);
  expect(smoke.comparable).toBe(false);
  expect(smoke.incomparableReasons).toContain("smoke_run");
});

test("malformed, cancelled or incompatible exports cannot become valid observations", () => {
  const raw = profileExport();
  expect(() => normalizeAgentXExport({ ...raw, was_cancelled: true }, workload, lexicon)).toThrow();
  expect(() => normalizeAgentXExport({ ...raw, schema_version: "0" }, workload, lexicon)).toThrow();
  expect(() => normalizeAgentXExport({ ...raw, time_to_first_token: { unit: "sec", avg: 1 } }, workload, lexicon)).toThrow();
  expect(() => normalizeAgentXExport({ ...raw, time_to_first_token: { unit: "ms", avg: NaN } }, workload, lexicon)).toThrow();
  expect(() => parseWorkload({ ...workload, tracePath: "../private" })).toThrow();
  const summary = normalizeAgentXExport(raw, { ...workload, mode: "smoke", durationSeconds: 60 }, lexicon);
  expect(() => parseAgentXSummary({ ...summary, comparable: true })).toThrow();
});

test("performance records have no correctness verdict, zero score or scoring denominator", async () => {
  const value = snapshot(), record = value.records[0];
  expect(record?.scoreStatus).toBe("not-applicable");
  expect(record && evaluationScore(record)).toBeUndefined();
  expect(() => assertAttemptRecord(record)).not.toThrow();
  const invalid = structuredClone(record);
  if (!invalid?.verdict) throw new Error("fixture verdict missing");
  invalid.verdict.score = 0;
  expect(() => assertAttemptRecord(invalid)).toThrow();
  expect(computeSuccessRate(value)).toMatchObject({ applicable: false, denominator: null, rate: null, passed: null });
  expect(await new HarborScoreMetrics({ dimensions: [] }).compute(value)).toMatchObject({ applicable: false, meanReward: null });
  const metrics = await new AgentXPerformanceMetrics().compute(value);
  const markdown = renderMarkdown(value, { "agentx-performance": metrics });
  expect(markdown).toContain("评分（不适用）");
  expect(markdown).not.toContain("| 计分题数 |");
  expect(markdown).toContain("Interactivity");
  expect(markdown).toContain("| point-1 | TTFT | ms | 12 | 10 | 25 | 31 | 120 |");
  expect(markdown).not.toContain("计 0 分");
  expect(markdown).not.toContain("模型答错");
});

test("incomplete performance measurements are retriable and corrupted source identities fail offline", async () => {
  const value = snapshot();
  const record = value.records[0];
  if (!record) throw new Error("fixture missing");
  record.executionStatus = "cancelled"; record.scoreStatus = record.evaluationKind === "performance" ? "not-applicable" : "invalid"; record.solve = null; record.verdict = null;
  finalizeAttemptOutcome(record);
  expect(isEvaluationComplete(record)).toBe(false);
  expect(record.scoreStatus).toBe("not-applicable");
  expect(() => assertAttemptRecord(record)).not.toThrow();
  const corrupt = snapshot();
  if (!corrupt.run.source) throw new Error("fixture source missing");
  corrupt.run.source.revision = "e".repeat(40);
  await expect(new AgentXPerformanceMetrics().compute(corrupt)).rejects.toThrow(/source lock/);
});

test("concurrency points retain their own percentiles in metrics and reports", async () => {
  const value = snapshot(), first = value.records[0];
  if (!first) throw new Error("fixture missing");
  const second = structuredClone(first);
  second.key = { ...second.key, taskId: "point-8", attemptId: "attempt-8" };
  if (!second.solve) throw new Error("fixture solve missing");
  const raw = profileExport();
  second.solve.observations = normalizeAgentXExport({ ...raw,
    time_to_first_token: { unit: "ms", avg: 80, p50: 60, p95: 140, p99: 200, count: 80 },
  }, { ...workload, concurrency: 8 }, lexicon);
  value.run.taskIds.push("point-8");
  value.run.taskIds.push("pending-point");
  value.pendingTaskIds.push("pending-point");
  value.records.push(second);
  const metrics = await new AgentXPerformanceMetrics().compute(value);
  const markdown = renderMarkdown(value, { "agentx-performance": metrics });
  expect(markdown).toContain("| point-1 | TTFT | ms | 12 | 10 | 25 | 31 | 120 |");
  expect(markdown).toContain("| point-8 | TTFT | ms | 80 | 60 | 140 | 200 | 80 |");
  expect(markdown).toContain("| point-1 | 1 | 40 | 440 | 10 / 25 | 7 / 12 | 1100 |");
  expect(markdown).toContain("| point-8 | 8 | 40 | 440 | 60 / 140 | 7 / 12 | 1100 |");
  expect(markdown).toContain("| pending-point | — | — | — | — / — | — / — | — |");
  expect(markdown).toContain("### 测量点 pending-point");
  const firstSection = markdown.slice(markdown.indexOf("### 测量点 point-1"), markdown.indexOf("### 测量点 point-8"));
  expect(firstSection).toContain("| point-1 | TTFT");
  expect(firstSection).not.toContain("| point-8 | TTFT");
  expect(markdown).not.toContain("| agentx-performance |");
  expect(markdown).not.toContain('"measurement"');
});
