import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/task.js";

/** Stable JSON for configuration and snapshot identity, independent of object insertion order. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function fingerprintConfig(config: JsonValue): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/**
 * Resume identity of a persisted configuration. The resolved output directory is
 * excluded: on the cluster coordinator it embeds the per-job path, which is
 * deployment plumbing rather than configuration drift between runs.
 */
export function fingerprintResumeConfig(persisted: JsonValue): string {
  if (persisted !== null && typeof persisted === "object" && !Array.isArray(persisted)) {
    const { output: _output, network: _network, hardware, ...rest } = persisted;
    // Preserve historical NPU fingerprints while rejecting a change to GPU.
    if (hardware !== undefined && hardware !== "npu") rest.hardware = hardware;
    return fingerprintConfig(rest as JsonValue);
  }
  return fingerprintConfig(persisted);
}
