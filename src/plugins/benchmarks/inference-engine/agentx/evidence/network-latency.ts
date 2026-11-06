import { expectPositiveNumber, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

export type AgentXNetworkLatencyConfig =
  | { mode: "automatic"; pingIntervalSeconds: number }
  | { mode: "manual"; meanMs: number };

export function parseNetworkLatencyConfig(value: unknown): AgentXNetworkLatencyConfig {
  const v = expectRecord(value, "agentx-replay.networkLatency");
  if (v.mode === "automatic") {
    rejectUnknown(v, ["mode", "pingIntervalSeconds"], "agentx-replay.networkLatency");
    return { mode: "automatic", pingIntervalSeconds: expectPositiveNumber(v.pingIntervalSeconds === undefined ? 1 : v.pingIntervalSeconds, "agentx-replay.networkLatency.pingIntervalSeconds") };
  }
  if (v.mode === "manual") {
    rejectUnknown(v, ["mode", "meanMs"], "agentx-replay.networkLatency");
    if (typeof v.meanMs !== "number" || !Number.isFinite(v.meanMs) || v.meanMs < 0)
      throw new TypeError("agentx-replay.networkLatency.meanMs must be a non-negative finite number");
    return { mode: "manual", meanMs: v.meanMs };
  }
  throw new TypeError("agentx-replay.networkLatency.mode must be automatic or manual");
}

export type AgentXNetworkLatencyProbes = { total: number; successful: number; failed: number };

export function parseNetworkLatencyProbes(value: unknown): AgentXNetworkLatencyProbes {
  const v = expectRecord(value, "AgentX network latency probes");
  rejectUnknown(v, ["total", "successful", "failed"], "AgentX network latency probes");
  for (const key of ["total", "successful", "failed"]) {
    const count = v[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new TypeError(`Invalid AgentX network latency probe count: ${key}`);
  }
  if (v.total !== Number(v.successful) + Number(v.failed)) throw new TypeError("Invalid AgentX network latency probe totals");
  return { total: Number(v.total), successful: Number(v.successful), failed: Number(v.failed) };
}
