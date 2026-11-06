import type { HardwareKind } from "../../../../../core/contracts/hardware.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

export type AgentXTelemetryConfig = {
  vllm?: { endpoint: string };
  ascend?: { endpoint: string; deviceId: number; chipId: number }
    | { mode: "local"; devices: { deviceId: number; chipId?: number }[] };
};
export type TelemetrySeries = {
  metric: string; unit: string; type: "gauge" | "counter"; labels: Record<string, string>;
  mean: number | null; min: number | null; max: number | null; total: number | null; rate: number | null;
};
type Window = { startNs: string; endNs: string };
export type AgentXTelemetrySource = {
  kind: "vllm" | "ascend"; endpoint: string | null; deviceId?: number; chipId?: number;
  status: "complete" | "partial" | "unavailable"; errors: string[]; missingMetrics: string[];
  /** Sampler diagnostics; available phase statistics remain usable. */
  warnings?: string[];
  window: Window | null; warmupWindow: Window | null; samples: number; warmupSamples: number;
  series: TelemetrySeries[]; warmupSeries: TelemetrySeries[];
};
export type AgentXTelemetry = {
  schemaVersion: 2;
  sources: AgentXTelemetrySource[];
  /** Harness aggregate across endpoints; absent in older saved results. */
  collectionErrors?: number;
};

function endpoint(value: unknown): string {
  const text = expectNonEmptyString(value, "AgentX telemetry endpoint");
  const url = new URL(text);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new TypeError("AgentX telemetry endpoint must be a credential-free HTTP(S) URL");
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/metrics") ? path : `${path}/metrics`;
  return url.href;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid AgentX telemetry integer");
  return value;
}
export function parseTelemetryConfig(value: unknown, hardware: HardwareKind = "npu"): AgentXTelemetryConfig {
  const raw = expectRecord(value, "agentx-replay.telemetry");
  rejectUnknown(raw, ["vllm", "ascend"], "agentx-replay.telemetry");
  const result: AgentXTelemetryConfig = {};
  if (raw.vllm !== undefined) {
    const v = expectRecord(raw.vllm, "telemetry.vllm");
    rejectUnknown(v, ["endpoint"], "telemetry.vllm");
    result.vllm = { endpoint: endpoint(v.endpoint) };
  }
  if (raw.ascend !== undefined) {
    if (hardware !== "npu") throw new TypeError("AgentX telemetry.ascend requires hardware=npu; selected hardware=gpu. GPU hardware telemetry is not implemented");
    const v = expectRecord(raw.ascend, "telemetry.ascend");
    if (v.mode === "local") {
      rejectUnknown(v, ["mode", "devices"], "telemetry.ascend");
      if (!Array.isArray(v.devices) || !v.devices.length) throw new TypeError("Local Ascend telemetry requires devices");
      const seen = new Set<number>();
      const devices = v.devices.map(value => {
        const device = expectRecord(value, "telemetry.ascend.devices entry");
        rejectUnknown(device, ["deviceId", "chipId"], "telemetry.ascend.devices entry");
        const deviceId = integer(device.deviceId);
        if (seen.has(deviceId)) throw new TypeError("Local Ascend telemetry contains a duplicate deviceId");
        seen.add(deviceId);
        return { deviceId, ...(device.chipId === undefined ? {} : { chipId: integer(device.chipId) }) };
      });
      result.ascend = { mode: "local", devices };
    } else {
      rejectUnknown(v, ["endpoint", "deviceId", "chipId"], "telemetry.ascend");
      result.ascend = { endpoint: endpoint(v.endpoint), deviceId: integer(v.deviceId), chipId: integer(v.chipId) };
    }
  }
  if (!result.vllm && !result.ascend) throw new TypeError("AgentX telemetry requires at least one source");
  return result;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TypeError("Invalid telemetry diagnostics");
  return value.map(String);
}

type SourceTarget = Pick<AgentXTelemetrySource, "kind" | "endpoint" | "deviceId" | "chipId" | "errors">;

function telemetryTargets(config: AgentXTelemetryConfig, evidence: unknown): SourceTarget[] {
  const targets: SourceTarget[] = config.vllm ? [{ kind: "vllm", ...config.vllm, errors: [] }] : [];
  const ascend = config.ascend;
  if (!ascend) return targets;
  if (!("mode" in ascend)) return [...targets, { kind: "ascend", ...ascend, errors: [] }];
  try {
    const raw = expectRecord(evidence, "telemetry evidence").localAscend;
    if (!Array.isArray(raw) || !raw.length) throw new TypeError("Missing local Ascend targets");
    const seen = new Set<string>(), endpoints = new Set<string>();
    const local = raw.map(value => {
      const item = expectRecord(value, "local Ascend target");
      const deviceId = integer(item.deviceId);
      const selected = ascend.devices.find(device => device.deviceId === deviceId);
      if (!selected) throw new TypeError("Unexpected local Ascend device");
      const chipId = item.chipId === undefined ? undefined : integer(item.chipId);
      if (selected.chipId !== undefined && chipId !== selected.chipId) throw new TypeError("Unexpected local Ascend chip");
      const key = `${deviceId}/${chipId ?? "unknown"}`;
      if (seen.has(key)) throw new TypeError("Duplicate local Ascend chip");
      seen.add(key);
      const errors = strings(item.errors);
      const address = item.endpoint === null ? null : endpoint(item.endpoint);
      if (address !== null) {
        const url = new URL(address);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/metrics" ||
          chipId === undefined || endpoints.has(address)) throw new TypeError("Invalid local Ascend endpoint");
        endpoints.add(address);
      } else if (!errors.length) throw new TypeError("Missing local Ascend failure diagnostics");
      return { kind: "ascend" as const, endpoint: address, deviceId, ...(chipId === undefined ? {} : { chipId }), errors };
    });
    for (const device of ascend.devices) {
      const chips = local.filter(target => target.deviceId === device.deviceId);
      if (!chips.length || chips.length > 1 && chips.some(target => target.chipId === undefined))
        throw new TypeError("Incomplete local Ascend discovery");
    }
    return [...targets, ...local];
  } catch {
    return [...targets, ...ascend.devices.map(device => ({ kind: "ascend" as const, endpoint: null, ...device,
      errors: ["Missing or invalid local NPU collection evidence; inspect local-telemetry.json"] }))];
  }
}

// Explicit names supported by the pinned Harness / vLLM exports. Never guess by substring.
type Metric = { names: string[]; unit: string; type: "gauge" | "counter"; required?: boolean };
const vllmMetrics: Metric[] = [
  { names: ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"], unit: "ratio", type: "gauge", required: true },
  { names: ["vllm:num_requests_running"], unit: "requests", type: "gauge", required: true },
  { names: ["vllm:num_requests_waiting"], unit: "requests", type: "gauge", required: true },
  { names: ["vllm:num_preemptions"], unit: "requests", type: "counter" },
  { names: ["vllm:prefix_cache_queries"], unit: "tokens", type: "counter" },
  { names: ["vllm:prefix_cache_hits"], unit: "tokens", type: "counter" },
  { names: ["vllm:prompt_tokens", "vllm:prompt_tokens_by_source"], unit: "tokens", type: "counter" },
  { names: ["vllm:generation_tokens"], unit: "tokens", type: "counter" },
];
const ascendMetrics: Metric[] = [
  { names: ["ascend_npu_utilization_percent"], unit: "%", type: "gauge", required: true },
  { names: ["ascend_npu_aicore_utilization_percent"], unit: "%", type: "gauge", required: true },
  { names: ["ascend_npu_hbm_usage_percent"], unit: "%", type: "gauge", required: true },
  { names: ["ascend_npu_hbm_capacity_megabytes"], unit: "MB", type: "gauge", required: true },
  { names: ["ascend_npu_hbm_bandwidth_percent"], unit: "%", type: "gauge", required: true },
  { names: ["ascend_npu_power_watts"], unit: "W", type: "gauge", required: true },
  { names: ["ascend_npu_temperature_celsius"], unit: "°C", type: "gauge", required: true },
];
function finite(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("Invalid AgentX telemetry value");
  return value;
}
function validateSeries(series: TelemetrySeries): TelemetrySeries {
  if (series.type === "gauge") {
    if (series.mean === null || series.total !== null || series.rate !== null ||
      (series.min !== null && series.min > series.mean) || (series.max !== null && series.max < series.mean))
      throw new TypeError("Invalid AgentX gauge statistics");
    const limit = series.unit === "ratio" ? 1 : series.unit === "%" ? 100 : null;
    if (limit !== null && [series.mean, series.min, series.max].some(v => v !== null && v > limit))
      throw new TypeError("Out-of-range AgentX gauge statistics");
  } else if (series.total === null || series.mean !== null || series.min !== null || series.max !== null) {
    throw new TypeError("Invalid AgentX counter statistics");
  }
  return series;
}
function labels(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value == null ? {} : expectRecord(value, "telemetry labels"))) {
    if (typeof item !== "string") throw new TypeError("Invalid AgentX telemetry label");
    result[key] = item;
  }
  return result;
}
function phaseWindow(value: unknown, normalized = false): Window | null {
  if (value == null) return null;
  const raw = expectRecord(value, "telemetry window");
  const startNs = String(raw[normalized ? "startNs" : "start_ns"]), endNs = String(raw[normalized ? "endNs" : "end_ns"]);
  if (!/^\d+$/u.test(startNs) || !/^\d+$/u.test(endNs) || BigInt(startNs) >= BigInt(endNs)) throw new TypeError("Invalid AgentX telemetry window");
  return { startNs, endNs };
}
function readSeries(metrics: unknown, source: AgentXTelemetrySource, model: string): TelemetrySeries[] {
  const raw = expectRecord(metrics, "server metrics");
  const result: TelemetrySeries[] = [];
  for (const spec of source.kind === "vllm" ? vllmMetrics : ascendMetrics) {
    for (const name of spec.names) {
      if (raw[name] === undefined) continue;
      const metric = expectRecord(raw[name], `server metric ${name}`);
      if (metric.type !== spec.type || !Array.isArray(metric.series)) throw new TypeError(`Invalid server metric ${name}`);
      for (const item of metric.series) {
        const s = expectRecord(item, "server metric series");
        if (s.endpoint_url !== source.endpoint) continue;
        const tags = labels(s.labels);
        if (source.kind === "ascend" && (tags.device_id !== String(source.deviceId) || tags.chip_id !== String(source.chipId))) continue;
        if (source.kind === "vllm" && tags.model_name !== undefined && tags.model_name !== model) continue;
        if (s.stats == null) continue;
        const stats = expectRecord(s.stats, "server metric stats");
        const series: TelemetrySeries = { metric: name, unit: spec.unit, type: spec.type, labels: tags,
          mean: spec.type === "gauge" ? finite(stats.avg) : null, min: spec.type === "gauge" ? finite(stats.min) : null,
          max: spec.type === "gauge" ? finite(stats.max) : null, total: spec.type === "counter" ? finite(stats.total) : null,
          rate: spec.type === "counter" ? finite(stats.rate) : null };
        if (series.mean !== null || series.total !== null) result.push(validateSeries(series));
      }
      if (result.some(s => s.metric === name)) break;
    }
  }
  return result;
}

/** Read only phase-scoped upstream statistics; raw JSON/JSONL remain attempt artifacts. */
export function normalizeTelemetry(config: AgentXTelemetryConfig, model: string, evidence: unknown): AgentXTelemetry {
  const sources: AgentXTelemetrySource[] = [];
  let collectionErrors: number | undefined;
  for (const selected of telemetryTargets(config, evidence)) {
    const { kind } = selected;
    const source: AgentXTelemetrySource = { ...selected, errors: [], status: "unavailable", missingMetrics: [],
      window: null, warmupWindow: null, samples: 0, warmupSamples: 0, series: [], warmupSeries: [] };
    if (source.endpoint === null) {
      source.errors = [...selected.errors];
      source.missingMetrics = ascendMetrics.map(spec => spec.names[0] ?? "");
      sources.push(source);
      continue;
    }
    if (selected.errors.length) source.warnings = [...selected.errors];
    try {
      const data = expectRecord(evidence, "telemetry evidence");
      if (data.error) throw new TypeError("AgentX server metrics export is unavailable");
      const raw = expectRecord(data.export, "server metrics export");
      if (raw.schema_version !== "1.1" || raw.metrics_phase !== "profiling") throw new TypeError("Unsupported server metrics export schema or phase");
      const summary = expectRecord(raw.summary, "server metrics summary");
      const ranges = expectRecord(summary.phase_time_ranges, "server metrics phase ranges");
      source.window = phaseWindow(ranges.profiling);
      source.warmupWindow = phaseWindow(ranges.warmup);
      const counts = expectRecord(expectRecord(data.samples, "server metric samples")[source.endpoint], "endpoint samples");
      source.samples = integer(counts.profiling);
      source.warmupSamples = integer(counts.warmup);
      source.series = source.window ? readSeries(raw.metrics, source, model) : [];
      source.warmupSeries = source.warmupWindow ? readSeries(raw.warmup_metrics ?? {}, source, model) : [];
      const specs = kind === "vllm" ? vllmMetrics : ascendMetrics;
      source.missingMetrics = specs.filter(spec => !source.series.some(s => spec.names.includes(s.metric))).map(spec => spec.names[0] ?? "");
      const requiredMissing = specs.some(spec => spec.required && !source.series.some(s => spec.names.includes(s.metric)));
      if (!source.window || source.samples === 0) source.errors.push("No profiling samples in the aggregation window");
      if (requiredMissing) source.errors.push("Required metrics for the selected model/device are missing");
      if (raw.evaluator_collection_error_count !== undefined)
        collectionErrors = integer(raw.evaluator_collection_error_count);
      if (!Array.isArray(summary.endpoints_successful) || !summary.endpoints_successful.includes(source.endpoint)) source.errors.push("Selected endpoint did not collect successfully");
      source.status = source.errors.length ? (source.series.length ? "partial" : "unavailable") : "complete";
    } catch {
      source.status = "unavailable";
      source.series = [];
      source.warmupSeries = [];
      source.errors.push("Missing or invalid AgentX server metrics evidence; inspect collected artifacts");
    }
    sources.push(source);
  }
  return { schemaVersion: 2, sources, ...(collectionErrors === undefined ? {} : { collectionErrors }) };
}

/** Convert the historical single-source-per-kind layout only at the saved-input boundary. */
function currentTelemetry(value: unknown): Record<string, unknown> {
  const raw = expectRecord(value, "AgentX telemetry");
  if (raw.schemaVersion !== 1) return raw;
  if (!Array.isArray(raw.sources) || raw.sources.length > 2) throw new TypeError("Invalid historical AgentX telemetry");
  const kinds = new Set<unknown>();
  for (const value of raw.sources) {
    const source = expectRecord(value, "historical telemetry source");
    if (kinds.has(source.kind) || source.endpoint === null) throw new TypeError("Invalid historical telemetry source identity");
    kinds.add(source.kind);
  }
  return { ...raw, schemaVersion: 2 };
}

/** Validate saved observations without network access or re-running collectors. */
export function parseTelemetry(value: unknown): AgentXTelemetry {
  const raw = currentTelemetry(value);
  if (raw.schemaVersion !== 2 || !Array.isArray(raw.sources) || raw.sources.length === 0) throw new TypeError("Invalid AgentX telemetry");
  const seen = new Set<string>();
  const sources = raw.sources.map(value => {
    const s = expectRecord(value, "telemetry source");
    const identity = s.kind === "vllm" ? String(s.kind) : `ascend/${s.deviceId}/${s.chipId ?? "unknown"}`;
    if ((s.kind !== "vllm" && s.kind !== "ascend") || seen.has(identity) || !["complete", "partial", "unavailable"].includes(String(s.status))) throw new TypeError("Invalid telemetry source identity");
    seen.add(identity);
    const read = (v: unknown): TelemetrySeries[] => {
      if (!Array.isArray(v)) throw new TypeError("Invalid telemetry series");
      return v.map(item => {
        const a = expectRecord(item, "telemetry series");
        const spec = (s.kind === "vllm" ? vllmMetrics : ascendMetrics).find(spec => spec.names.includes(String(a.metric)));
        if (!spec || spec.type !== a.type || spec.unit !== a.unit) throw new TypeError("Invalid telemetry metric identity");
        const tags = labels(a.labels);
        if (s.kind === "ascend" && (tags.device_id !== String(s.deviceId) || tags.chip_id !== String(s.chipId))) throw new TypeError("Invalid telemetry device labels");
        return validateSeries({ metric: String(a.metric), unit: spec.unit, type: spec.type, labels: tags,
          mean: finite(a.mean), min: finite(a.min), max: finite(a.max), total: finite(a.total), rate: finite(a.rate) });
      });
    };
    const unavailableLocal = s.kind === "ascend" && s.endpoint === null && s.status === "unavailable";
    const source: AgentXTelemetrySource = { kind: s.kind, endpoint: unavailableLocal ? null : endpoint(s.endpoint), status: s.status === "complete" ? "complete" : s.status === "partial" ? "partial" : "unavailable",
      ...(s.kind === "ascend" ? { deviceId: integer(s.deviceId), ...(unavailableLocal && s.chipId === undefined ? {} : { chipId: integer(s.chipId) }) } : {}),
      errors: strings(s.errors), missingMetrics: strings(s.missingMetrics), window: phaseWindow(s.window, true), warmupWindow: phaseWindow(s.warmupWindow, true),
      ...(s.warnings === undefined ? {} : { warnings: strings(s.warnings) }),
      samples: integer(s.samples), warmupSamples: integer(s.warmupSamples), series: read(s.series), warmupSeries: read(s.warmupSeries) };
    if (unavailableLocal && (!source.errors.length || source.series.length || source.warmupSeries.length || source.samples || source.warmupSamples || source.window || source.warmupWindow))
      throw new TypeError("Invalid unavailable local telemetry source");
    if (source.status === "complete" && (!source.window || !source.samples || source.errors.length ||
      (source.kind === "vllm" ? vllmMetrics : ascendMetrics).some(spec => spec.required && !source.series.some(x => spec.names.includes(x.metric))))) throw new TypeError("Invalid telemetry completeness");
    return source;
  });
  return { schemaVersion: 2, sources,
    ...(raw.collectionErrors === undefined ? {} : { collectionErrors: integer(raw.collectionErrors) }) };
}
