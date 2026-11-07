import { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";
import type { Usage } from "../../../../../core/contracts/result.js";
import { parseTelemetry, type AgentXTelemetry } from "./telemetry.js";
import { parseNetworkLatencyConfig, parseNetworkLatencyProbes, type AgentXNetworkLatencyConfig, type AgentXNetworkLatencyProbes } from "./network-latency.js";

import { AGENTX_VERSION } from "../../../../../runtimes/agentx/versions.js";

export type AgentXVariant = "256k" | "full";
// Keep smoke readable for saved results and controlled bridge tests; new YAML rejects it.
export type AgentXMode = "standard" | "smoke" | "replay";
export type AgentXWorkload = {
  schemaVersion: 1;
  kind: "agentx";
  variant: AgentXVariant;
  mode: AgentXMode;
  concurrency: number;
  durationSeconds: number;
  seed: number;
  dataset: string;
  loader: string;
  revision: string;
  sha256: string;
  tracePath: string;
  traceCount?: number;
};

export function parseWorkload(value: unknown): AgentXWorkload {
  const v = expectRecord(value, "AgentX workload");
  rejectUnknown(v, ["schemaVersion", "kind", "variant", "mode", "concurrency", "durationSeconds", "seed", "dataset", "loader", "revision", "sha256", "tracePath", "traceCount"], "AgentX workload");
  if (v.schemaVersion !== 1 || v.kind !== "agentx" || !["256k", "full"].includes(String(v.variant)) ||
    !["standard", "smoke", "replay"].includes(String(v.mode)) || !Number.isSafeInteger(v.seed) ||
    !/^(?:[a-f0-9]{40}|local:[a-f0-9]{64})$/u.test(String(v.revision)) || !/^[a-f0-9]{64}$/u.test(String(v.sha256)) ||
    v.tracePath !== "input/traces.jsonl") throw new TypeError("Invalid AgentX workload identity");
  const variant = v.variant === "full" ? "full" : "256k";
  const dataset = `semianalysisai/cc-traces-weka-062126${variant === "256k" ? "-256k" : ""}`;
  const loader = `semianalysis_cc_traces_weka_062126${variant === "256k" ? "_256k" : ""}`;
  if (v.dataset !== dataset || v.loader !== loader) throw new TypeError("AgentX workload corpus differs from its variant");
  const durationSeconds = expectPositiveInteger(v.durationSeconds, "AgentX durationSeconds");
  if (v.mode === "standard" && v.seed !== 42)
    throw new TypeError("AgentX standard requires seed=42");
  const traceCount = v.mode === "replay" ? expectPositiveInteger(v.traceCount, "AgentX traceCount") : undefined;
  if (v.mode !== "replay" && v.traceCount !== undefined) throw new TypeError("AgentX traceCount requires replay mode");
  const concurrency = expectPositiveInteger(v.concurrency, "AgentX concurrency");
  if (traceCount !== undefined && concurrency > traceCount) throw new TypeError("AgentX replay concurrency exceeds traceCount");
  let mode: AgentXMode = "smoke";
  if (v.mode === "replay") mode = "replay";
  else if (v.mode === "standard") mode = "standard";
  return { schemaVersion: 1, kind: "agentx", variant, mode,
    concurrency, durationSeconds, seed: Number(v.seed),
    dataset, loader, revision: String(v.revision), sha256: String(v.sha256), tracePath: "input/traces.jsonl",
    ...(traceCount === undefined ? {} : { traceCount }) };
}

export type AgentXReplayCoverage = {
  schemaVersion: 1;
  selectedTraces: number;
  completedTraces: number;
  expectedRequests: number;
  observedRequests: number;
  successfulRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  missingRequests: number;
  duplicateRequests: number;
  unexpectedRequests: number;
  complete: boolean;
};

function parseReplayCoverage(value: unknown, workload: AgentXWorkload): AgentXReplayCoverage {
  const v = expectRecord(value, "AgentX replay coverage");
  if (v.schemaVersion !== 1 || typeof v.complete !== "boolean") throw new TypeError("Invalid AgentX replay coverage");
  const integer = (key: string): number => {
    const n = v[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`Invalid AgentX coverage ${key}`);
    return n;
  };
  const result: AgentXReplayCoverage = { schemaVersion: 1, selectedTraces: integer("selectedTraces"), completedTraces: integer("completedTraces"),
    expectedRequests: integer("expectedRequests"), observedRequests: integer("observedRequests"), successfulRequests: integer("successfulRequests"),
    failedRequests: integer("failedRequests"), cancelledRequests: integer("cancelledRequests"), missingRequests: integer("missingRequests"),
    duplicateRequests: integer("duplicateRequests"), unexpectedRequests: integer("unexpectedRequests"), complete: v.complete };
  if (result.selectedTraces !== workload.traceCount || result.expectedRequests === 0 ||
    result.completedTraces > result.selectedTraces || result.observedRequests !== result.successfulRequests + result.failedRequests + result.cancelledRequests ||
    !result.complete || result.completedTraces !== result.selectedTraces || result.observedRequests !== result.expectedRequests ||
    result.missingRequests !== 0 || result.duplicateRequests !== 0 || result.unexpectedRequests !== 0 || result.cancelledRequests !== 0)
    throw new TypeError("AgentX full trace replay did not cover every selected request exactly once");
  return result;
}

export type AgentXStatistic = {
  unit: string;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number | null;
};
export type AgentXStatistics = Record<string, AgentXStatistic | null>;
export type AgentXNetworkLatencySummary = {
  config: AgentXNetworkLatencyConfig;
  status: "complete" | "partial" | "unavailable";
  rttMs: number | null;
  probes: AgentXNetworkLatencyProbes | null;
  adjusted: AgentXStatistics;
  warnings: string[];
};
export type AgentXSummary = {
  schemaVersion: 1;
  kind: "agentx";
  harnessVersion: string;
  workload: AgentXWorkload;
  lexicon: { source: string; revision: string; digest: string };
  profiling: AgentXStatistics;
  warmup: AgentXStatistics;
  upstreamSubmissionValid: boolean | null;
  upstreamInvalidReasons: string[];
  comparable: boolean;
  incomparableReasons: string[];
  replayCoverage?: AgentXReplayCoverage;
  telemetry?: AgentXTelemetry;
  networkLatency?: AgentXNetworkLatencySummary;
};

const fields: Record<string, { tag: string; unit: string }> = {
  ttft: { tag: "time_to_first_token", unit: "ms" },
  ttfo: { tag: "time_to_first_output_token", unit: "ms" },
  itl: { tag: "inter_token_latency", unit: "ms" },
  requestLatency: { tag: "request_latency", unit: "ms" },
  inputThroughput: { tag: "input_token_throughput", unit: "tokens/sec" },
  outputThroughput: { tag: "output_token_throughput", unit: "tokens/sec" },
  totalThroughput: { tag: "total_token_throughput", unit: "tokens/sec" },
  interactivity: { tag: "output_token_throughput_per_user", unit: "tokens/sec/user" },
  fullResponseInteractivity: { tag: "full_response_output_token_throughput_per_user", unit: "tokens/sec/user" },
  requests: { tag: "request_count", unit: "requests" },
  errors: { tag: "error_request_count", unit: "requests" },
  duration: { tag: "benchmark_duration", unit: "sec" },
  inputTokens: { tag: "total_isl", unit: "tokens" },
  outputTokens: { tag: "total_osl", unit: "tokens" },
};

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("Invalid AgentX metric value");
  return value;
}

const adjustedFields = {
  ttft: { tag: "network_adjusted_time_to_first_token", unit: "ms" },
  ttfo: { tag: "network_adjusted_time_to_first_output_token", unit: "ms" },
  requestLatency: { tag: "network_adjusted_request_latency", unit: "ms" },
};

function statistics(value: Record<string, unknown>, definitions = fields): AgentXStatistics {
  return Object.fromEntries(Object.entries(definitions).map(([name, { tag, unit }]) => {
    const raw = value[tag];
    if (raw === null || raw === undefined) return [name, null];
    const metric = expectRecord(raw, `AgentX ${tag}`);
    if (metric.unit !== unit) throw new TypeError(`AgentX ${tag} must use ${unit}`);
    const count = nullableNumber(metric.count);
    if (count !== null && !Number.isSafeInteger(count)) throw new TypeError("Invalid AgentX metric count");
    return [name, { unit, mean: nullableNumber(metric.avg), p50: nullableNumber(metric.p50),
      p95: nullableNumber(metric.p95), p99: nullableNumber(metric.p99), count }];
  }));
}

function savedStatistics(value: unknown, definitions = fields): AgentXStatistics {
  const stats = expectRecord(value, "AgentX statistics");
  return Object.fromEntries(Object.entries(definitions).map(([name, { unit }]) => {
    const item = stats[name];
    // TTFO was added after the initial persisted summary format.
    if (item === null || (name === "ttfo" && item === undefined)) return [name, null];
    const stat = expectRecord(item, `AgentX statistic ${name}`);
    if (stat.unit !== unit) throw new TypeError(`Invalid AgentX statistic unit: ${name}`);
    const count = nullableNumber(stat.count);
    if (count !== null && !Number.isSafeInteger(count)) throw new TypeError("Invalid AgentX statistic count");
    return [name, { unit, mean: nullableNumber(stat.mean), p50: nullableNumber(stat.p50),
      p95: nullableNumber(stat.p95), p99: nullableNumber(stat.p99), count }];
  }));
}

function networkLatencySummary(config: AgentXNetworkLatencyConfig, rttMs: number | null,
  adjusted: AgentXStatistics, profiling: AgentXStatistics, probes: AgentXNetworkLatencyProbes | null): AgentXNetworkLatencySummary {
  const warnings: string[] = [];
  if (rttMs === null) warnings.push("官方未导出用于校准的平均 RTT");
  const missing = Object.keys(adjustedFields).filter(key => profiling[key]?.mean != null && adjusted[key]?.mean == null);
  if (missing.length) warnings.push(`官方未导出修正指标：${missing.join(", ")}`);
  if (config.mode === "automatic") {
    if (probes === null) warnings.push("未获得 RTT 探测记录");
    else if (probes.failed > 0) warnings.push(`RTT 探测失败 ${probes.failed} 次`);
  }
  const available = Object.values(adjusted).some(stat => stat?.mean != null);
  const status = rttMs === null || !available ? "unavailable" : warnings.length ? "partial" : "complete";
  return { config, status, rttMs, probes, adjusted, warnings };
}

/** Read the pinned export format, without re-estimating rates or averaging percentiles. */
export function normalizeAgentXExport(value: unknown, workload: AgentXWorkload, lexicon: AgentXSummary["lexicon"], coverage?: unknown,
  network?: { config: AgentXNetworkLatencyConfig; probes?: unknown }): AgentXSummary {
  const raw = expectRecord(value, "AgentX export");
  if (raw.schema_version !== "1.4") throw new TypeError("Unsupported AgentX export schema (expected 1.4)");
  if (raw.was_cancelled !== false) throw new TypeError("AgentX profiling did not complete");
  const metadata = raw.metadata == null ? {} : expectRecord(raw.metadata, "AgentX metadata");
  if (metadata.scenario !== "agentx") throw new TypeError("AgentX export scenario differs from agentx");
  const valid = metadata.submission_valid;
  if (valid !== undefined && typeof valid !== "boolean") throw new TypeError("Invalid AgentX submission_valid");
  const reasons = metadata.submission_invalid_reasons ?? [];
  if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== "string")) throw new TypeError("Invalid AgentX submission reasons");
  const profiling = statistics(raw);
  const incomparableReasons = [...reasons.map(String)];
  if (workload.mode !== "standard") incomparableReasons.push(workload.mode === "replay" ? "full_trace_replay" : "smoke_run");
  if (workload.mode === "standard" && workload.durationSeconds !== 3600) incomparableReasons.push("custom_duration");
  if (valid !== true) incomparableReasons.push("upstream_submission_not_valid");
  const measured = profiling.duration?.mean;
  // The observed first/last response span can differ from the configured phase
  // duration. The harness validates metric-duration coverage for the phase.
  if (measured == null || measured <= 0) incomparableReasons.push("missing_profiling_window");
  if (!(profiling.requests?.mean && profiling.requests.mean > 0)) incomparableReasons.push("no_successful_requests");
  return { schemaVersion: 1, kind: "agentx", harnessVersion: AGENTX_VERSION, workload, lexicon,
    profiling, warmup: statistics(raw.warmup_metrics == null ? {} : expectRecord(raw.warmup_metrics, "AgentX warmup")),
    upstreamSubmissionValid: typeof valid === "boolean" ? valid : null, upstreamInvalidReasons: reasons.map(String),
    comparable: incomparableReasons.length === 0, incomparableReasons: [...new Set(incomparableReasons)],
    ...(workload.mode === "replay" ? { replayCoverage: parseReplayCoverage(coverage, workload) } : {}),
    ...(network === undefined ? {} : { networkLatency: networkLatencySummary(network.config,
      statistics(raw, { rtt: { tag: "network_rtt", unit: "ms" } }).rtt?.mean ?? null,
      statistics(raw, adjustedFields), profiling,
      network.probes == null ? null : parseNetworkLatencyProbes(network.probes)) }) };
}

/** Stored observations are a trust boundary, including offline reports. */
export function parseAgentXSummary(value: unknown): AgentXSummary {
  assertJsonValue(value, "AgentX observations");
  const raw = expectRecord(value, "AgentX observations");
  if (raw.schemaVersion !== 1 || raw.kind !== "agentx" || raw.harnessVersion !== AGENTX_VERSION ||
    typeof raw.comparable !== "boolean" || (raw.upstreamSubmissionValid !== null && typeof raw.upstreamSubmissionValid !== "boolean"))
    throw new TypeError("Invalid AgentX summary");
  const workload = parseWorkload(raw.workload);
  const lexicon = expectRecord(raw.lexicon, "AgentX lexicon");
  for (const key of ["source", "revision", "digest"]) expectNonEmptyString(lexicon[key], `AgentX lexicon.${key}`);
  if (!/^[a-f0-9]{64}$/u.test(String(lexicon.digest)) ||
    (lexicon.revision !== "local" && !/^[a-f0-9]{40}$/u.test(String(lexicon.revision))))
    throw new TypeError("Invalid AgentX lexicon identity");
  const profiling = savedStatistics(raw.profiling);
  let networkLatency: AgentXNetworkLatencySummary | undefined;
  if (raw.networkLatency !== undefined) {
    const n = expectRecord(raw.networkLatency, "AgentX network latency");
    rejectUnknown(n, ["config", "status", "rttMs", "probes", "adjusted", "warnings"], "AgentX network latency");
    networkLatency = networkLatencySummary(parseNetworkLatencyConfig(n.config), nullableNumber(n.rttMs),
      savedStatistics(n.adjusted, adjustedFields), profiling, n.probes === null ? null : parseNetworkLatencyProbes(n.probes));
    if (n.status !== networkLatency.status || !Array.isArray(n.warnings) || n.warnings.some(warning => typeof warning !== "string"))
      throw new TypeError("Invalid AgentX network latency status or warnings");
    // Keep recorded diagnostics readable if wording changes in a later release.
    networkLatency.warnings = n.warnings;
    if (networkLatency.config.mode === "manual" && networkLatency.probes !== null)
      throw new TypeError("Manual AgentX network latency must not contain probe counts");
  }
  const strings = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new TypeError("Invalid AgentX reasons");
    return value.map(String);
  };
  const incomparableReasons = strings(raw.incomparableReasons);
  if (raw.comparable && (workload.mode !== "standard" || workload.durationSeconds !== 3600 || raw.upstreamSubmissionValid !== true || incomparableReasons.length))
    throw new TypeError("Invalid AgentX comparability");
  return { schemaVersion: 1, kind: "agentx", harnessVersion: AGENTX_VERSION, workload,
    lexicon: { source: String(lexicon.source), revision: String(lexicon.revision), digest: String(lexicon.digest) },
    profiling, warmup: savedStatistics(raw.warmup),
    upstreamSubmissionValid: raw.upstreamSubmissionValid, upstreamInvalidReasons: strings(raw.upstreamInvalidReasons),
    comparable: raw.comparable, incomparableReasons,
    ...(workload.mode === "replay" ? { replayCoverage: parseReplayCoverage(raw.replayCoverage, workload) } : {}),
    ...(raw.telemetry === undefined ? {} : { telemetry: parseTelemetry(raw.telemetry) }),
    ...(networkLatency === undefined ? {} : { networkLatency }) };
}

export function agentXUsage(summary: AgentXSummary): Usage {
  const total = (key: string): number | null => {
    const profile = summary.profiling[key]?.mean;
    const warmup = summary.warmup[key]?.mean;
    if (profile == null || warmup == null) return null;
    const value = profile + warmup;
    return Number.isSafeInteger(value) ? value : null;
  };
  const inputTokens = total("inputTokens"), outputTokens = total("outputTokens");
  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens: totalTokens !== null && Number.isSafeInteger(totalTokens) ? totalTokens : null };
}
