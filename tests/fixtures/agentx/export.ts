import type { AgentXWorkload } from "../../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";

export const workload: AgentXWorkload = {
  schemaVersion: 1, kind: "agentx", mode: "standard", variant: "256k", concurrency: 1,
  durationSeconds: 3600, seed: 42, dataset: "semianalysisai/cc-traces-weka-062126-256k",
  loader: "semianalysis_cc_traces_weka_062126_256k", revision: "a".repeat(40), sha256: "b".repeat(64), tracePath: "input/traces.jsonl",
};
export const lexicon = { source: "fixture/tokenizer", revision: "c".repeat(40), digest: "d".repeat(64) };
export function profileExport() {
  return { schema_version: "1.4", was_cancelled: false,
    metadata: { scenario: "agentx", submission_valid: true, submission_invalid_reasons: [] },
    request_count: { unit: "requests", avg: 120 }, error_request_count: { unit: "requests", avg: 0 },
    benchmark_duration: { unit: "sec", avg: 3599.8 },
    time_to_first_token: { unit: "ms", avg: 12, p50: 10, p95: 25, p99: 31, count: 120 },
    inter_token_latency: { unit: "ms", avg: 8, p50: 7, p95: 12, p99: 20, count: 120 },
    request_latency: { unit: "ms", avg: 900, p50: 850, p95: 1100, p99: 1200, count: 120 },
    output_token_throughput: { unit: "tokens/sec", avg: 40 },
    input_token_throughput: { unit: "tokens/sec", avg: 400 },
    total_token_throughput: { unit: "tokens/sec", avg: 440 },
    output_token_throughput_per_user: { unit: "tokens/sec/user", avg: 125 },
    total_isl: { unit: "tokens", avg: 1440000 }, total_osl: { unit: "tokens", avg: 144000 },
    warmup_metrics: { request_count: { unit: "requests", avg: 10 },
      time_to_first_token: { unit: "ms", avg: 99999, p95: 99999 },
      total_isl: { unit: "tokens", avg: 1000 }, total_osl: { unit: "tokens", avg: 100 } } };
}

export function networkProfileExport() {
  return { ...profileExport(),
    time_to_first_output_token: { unit: "ms", avg: 15, p50: 12, p95: 28, p99: 35, count: 120 },
    network_rtt: { unit: "ms", avg: 4, count: 1 },
    network_adjusted_time_to_first_token: { unit: "ms", avg: 8.125, p50: 6, p95: 21, p99: 27, count: 120 },
    network_adjusted_time_to_first_output_token: { unit: "ms", avg: 11, p50: 8, p95: 24, p99: 31, count: 120 },
    network_adjusted_request_latency: { unit: "ms", avg: 896, p50: 846, p95: 1096, p99: 1196, count: 120 } };
}
