import type { HardwareKind } from "../core/contracts/hardware.js";
import { parseHardware } from "./hardware.js";
import { parseDeployment, type Deployment } from "./deployment.js";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { type EffectiveConfig } from "../core/contracts/config.js";

export type PluginSelection = { name?: string; config?: Record<string, unknown>; service?: string };
export type EnvironmentInput = Omit<PluginSelection, "service"> & { platform?: string };
export type SchedulerInput = Omit<PluginSelection, "service"> & { concurrency?: number; nodes?: number };
export type BenchmarkSelection = Omit<PluginSelection, "service"> & {
  name: string;
  version?: string;
  scenario?: string;
  solver?: string | PluginSelection;
  verifier?: string | PluginSelection;
};
export type ServiceInput = {
  model: string;
  base_url: string;
  api_key?: string;
  api?: string;
  provider?: string;
  maxTokens?: number;
  contextWindow?: number;
  retry?: { maxAttempts: number };
};
export type UserConfig = {
  /** Defaults to NPU for existing callers and saved configurations. */
  hardware?: HardwareKind;
  deployment?: Deployment;
  services: Record<string, ServiceInput>;
  benchmark: string | BenchmarkSelection;
  environment?: string | EnvironmentInput;
  scheduler?: string | SchedulerInput;
  store?: string | PluginSelection;
  reporter?: string | PluginSelection;
  metrics?: (string | PluginSelection)[];
  run?: Partial<EffectiveConfig["run"]>;
  output?: { directory?: string };
};

/** Normalize only public shortcuts. Private plugin options remain owned by their validator. */
export function normalizeSelection(value: unknown, path: string, flat: readonly string[] = [], route = false): PluginSelection {
  if (typeof value === "string") return { name: expectNonEmptyString(value, path), config: {} };
  const record = expectRecord(value, path);
  rejectUnknown(record, ["name", "config", ...(route ? ["service"] : []), ...flat], path);
  const config = record.config === undefined ? {} : structuredClone(expectRecord(record.config, `${path}.config`));
  for (const key of flat) {
    if (Object.hasOwn(record, key)) {
      if (Object.hasOwn(config, key)) throw new TypeError(`${path}.${key} duplicates ${path}.config.${key}`);
      config[key] = record[key];
    }
  }
  return {
    ...(record.name === undefined ? {} : { name: expectNonEmptyString(record.name, `${path}.name`) }),
    config,
    ...(record.service === undefined ? {} : { service: expectNonEmptyString(record.service, `${path}.service`) }),
  };
}

export function normalizeComponentSelection(value: unknown, role: "environment" | "scheduler" | "store" | "reporter"): PluginSelection {
  const flat: string[] = [];
  if (role === "environment") flat.push("platform");
  else if (role === "scheduler") flat.push("concurrency", "nodes");
  return normalizeSelection(value, role, flat);
}

export function parseUserConfig(value: unknown): UserConfig {
  const record = expectRecord(value, "configuration");
  rejectUnknown(record, ["hardware", "services", "benchmark", "environment", "scheduler", "store", "reporter", "metrics", "run", "output", "deployment"], "configuration");
  const services = expectRecord(record.services, "services");
  if (!Object.keys(services).length) throw new TypeError("services must declare at least one service");
  const parsedServices: UserConfig["services"] = {};
  for (const [name, service] of Object.entries(services)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) throw new TypeError(`services.${name} is not a valid service name`);
    const entry = expectRecord(service, `services.${name}`);
    rejectUnknown(entry, ["model", "base_url", "api_key", "api", "provider", "maxTokens", "contextWindow", "retry"], `services.${name}`);
    const parsed: ServiceInput = { model: expectNonEmptyString(entry.model, `services.${name}.model`), base_url: expectNonEmptyString(entry.base_url, `services.${name}.base_url`) };
    for (const key of ["api_key", "api", "provider"] as const)
      if (entry[key] !== undefined) parsed[key] = expectNonEmptyString(entry[key], `services.${name}.${key}`);
    if (entry.maxTokens !== undefined) parsed.maxTokens = expectPositiveInteger(entry.maxTokens, `services.${name}.maxTokens`);
    if (entry.contextWindow !== undefined) parsed.contextWindow = expectPositiveInteger(entry.contextWindow, `services.${name}.contextWindow`);
    if (entry.retry !== undefined) {
      const retry = expectRecord(entry.retry, `services.${name}.retry`);
      rejectUnknown(retry, ["maxAttempts"], `services.${name}.retry`);
      parsed.retry = { maxAttempts: expectPositiveInteger(retry.maxAttempts, `services.${name}.retry.maxAttempts`) };
    }
    parsedServices[name] = parsed;
  }
  const rawBenchmark = typeof record.benchmark === "string" ? { name: record.benchmark } : expectRecord(record.benchmark, "benchmark");
  rejectUnknown(rawBenchmark, ["name", "config", "version", "scenario", "solver", "verifier"], "benchmark");
  const benchmark: BenchmarkSelection = {
    name: expectNonEmptyString(rawBenchmark.name, "benchmark.name"),
    ...(rawBenchmark.config === undefined ? {} : { config: structuredClone(expectRecord(rawBenchmark.config, "benchmark.config")) }),
    ...(rawBenchmark.version === undefined ? {} : { version: expectNonEmptyString(rawBenchmark.version, "benchmark.version") }),
    ...(rawBenchmark.scenario === undefined ? {} : { scenario: expectNonEmptyString(rawBenchmark.scenario, "benchmark.scenario") }),
    ...(rawBenchmark.solver === undefined ? {} : { solver: normalizeSelection(rawBenchmark.solver, "benchmark.solver", [], true) }),
    ...(rawBenchmark.verifier === undefined ? {} : { verifier: normalizeSelection(rawBenchmark.verifier, "benchmark.verifier", [], true) }),
  };
  const result: UserConfig = { services: parsedServices, benchmark,
    ...(record.hardware === undefined ? {} : { hardware: parseHardware(record.hardware) }),
    ...(record.deployment === undefined ? {} : { deployment: parseDeployment(record.deployment) }) };
  for (const role of ["environment", "scheduler", "store", "reporter"] as const) {
    if (record[role] !== undefined) result[role] = normalizeComponentSelection(record[role], role);
  }
  if (record.metrics !== undefined) {
    if (!Array.isArray(record.metrics) || !record.metrics.length) throw new TypeError("metrics must be a non-empty selection array");
    result.metrics = record.metrics.map((item, index) => normalizeSelection(item, `metrics[${index}]`));
  }
  if (record.run !== undefined) result.run = structuredClone(expectRecord(record.run, "run"));
  if (record.output !== undefined) {
    const output = expectRecord(record.output, "output");
    rejectUnknown(output, ["directory"], "output");
    result.output = output.directory === undefined ? {} : { directory: expectNonEmptyString(output.directory, "output.directory") };
  }
  return result;
}
