import type { AgentXTelemetryConfig } from "../../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";

export const telemetryConfig = {
  vllm: { endpoint: "http://127.0.0.1:18094/metrics" },
  ascend: { endpoint: "http://127.0.0.1:18095/metrics", deviceId: 4, chipId: 0 },
} satisfies AgentXTelemetryConfig;
export function serverMetricsEvidence() {
  const vllm = telemetryConfig.vllm?.endpoint ?? "", ascend = telemetryConfig.ascend?.endpoint ?? "";
  const gauge = (endpoint_url: string, labels: Record<string, string>, avg: number) => ({ type: "gauge" as const, series: [
    { endpoint_url, labels, stats: { avg, min: avg / 2, max: avg * 1.5 } },
  ] });
  const counter = (total: number) => ({ type: "counter" as const, series: [
    { endpoint_url: vllm, labels: { model_name: "fixture-model", engine: "0" }, stats: { total, rate: total / 10 } },
  ] });
  const metrics = {
    "vllm:kv_cache_usage_perc": gauge(vllm, { model_name: "fixture-model", engine: "0" }, 0.5),
    "vllm:num_requests_running": gauge(vllm, { model_name: "fixture-model" }, 1),
    "vllm:num_requests_waiting": gauge(vllm, { model_name: "fixture-model" }, 0),
    "vllm:prefix_cache_queries": counter(100), "vllm:prefix_cache_hits": counter(75),
    "vllm:num_preemptions": counter(2), "vllm:prompt_tokens": counter(1000), "vllm:generation_tokens": counter(100),
    "ascend_npu_utilization_percent": gauge(ascend, { device_id: "4", chip_id: "0" }, 50),
    ...Object.fromEntries(["aicore_utilization_percent", "hbm_usage_percent", "hbm_capacity_megabytes",
      "hbm_bandwidth_percent", "power_watts", "temperature_celsius"].map(key => ["ascend_npu_" + key, gauge(ascend, { device_id: "4", chip_id: "0" }, 50)])),
  };
  return { export: { schema_version: "1.1", metrics_phase: "profiling", summary: {
    endpoints_successful: [vllm, ascend], phase_time_ranges: { profiling: { start_ns: "1000000000", end_ns: "11000000000" }, warmup: { start_ns: "1", end_ns: "999999999" } },
  }, metrics, warmup_metrics: { "vllm:kv_cache_usage_perc": gauge(vllm, { model_name: "fixture-model" }, 0.01) } },
  samples: { [vllm]: { profiling: 30, warmup: 3 }, [ascend]: { profiling: 10, warmup: 1 } }, error: null };
}
