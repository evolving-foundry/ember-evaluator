import type { HardwareKind } from "../core/contracts/hardware.js";
import type { JsonValue, PhaseTimeoutOverrides } from "../core/contracts/task.js";

export type CliOverrides = {
  model?: string;
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  /** Explicit runtime extensions; credentials must use environment references. */
  plugins?: import("../core/contracts/plugin-extension.js").PluginActivation[];
};

export type ModelConfig = {
  name: string;
  endpoint: string | null;
  provider: string | null;
  api: string | null;
  /** Per-response ceiling; custom OpenAI Chat Completions omits the wire limit when unset. */
  maxTokens?: number;
  /** Input context threshold for automatic compaction, independent of output length. */
  contextWindow?: number;
  /** Model-call retry budget; absent values keep the default of 4 attempts. */
  retry?: { maxAttempts: number };
};

export type Selection = {
  name: string;
  config: Record<string, unknown>;
};

/** Solver selection plus the named entry in top-level `services` it should run. */
export type SolverSelection = Selection & { service: string };
export type VerifierSelection = Selection & { service?: string };

export type EffectiveConfig = {
  /** Defaults to NPU for existing callers and saved configurations. */
  hardware?: HardwareKind;
  /** Every declared model service. Callers bind the one they reference. */
  services: Record<string, ModelConfig>;
  benchmark: Selection;
  verifier?: VerifierSelection;
  environment: Selection;
  solver: SolverSelection;
  metrics: Selection[];
  reporter: Selection;
  store: Selection;
  scheduler: Selection;
  run: PhaseTimeoutOverrides & {
    maxTasks: number | null;
    /** Skip this many candidates after taskIds filtering and optional shuffling; absent means 0. */
    offset?: number;
    taskIds: string[] | null;
    timeoutSeconds: number;
    sampling?: { strategy: "random"; seed: number };
    /** Absent means "abort": failed/invalid tasks stop the run; valid Agent deadlines can refill the slot. */
    onError?: "abort" | "continue";
    /** Absent or false omits the original prompt and textual answer from each result. */
    includeTaskAnswer?: boolean;
    /** Local preparation defaults to pipeline, with preparation concurrency matching execution. */
    preparation?: { mode: "batch" | "pipeline"; concurrency: number; lookahead?: number;
      environmentTimeoutSeconds?: number; roundTimeoutSeconds?: number };
  };
  output: { directory: string };
};

export type RuntimeAuth = {
  value: string;
  reference: string | null;
};

export type LoadedConfig = {
  /** User-selected profile name, before expansion to an implementation such as harbor. */
  benchmarkName?: string;
  network?: import("../core/contracts/network.js").NetworkDocument;
  deployment?: import("./deployment.js").Deployment;
  experiment: EffectiveConfig;
  /** Secrets for services whose credentials were resolved. The solver's service is always present. */
  auths: Record<string, RuntimeAuth>;
  persisted: JsonValue;
  /** Explanations only; excluded from persisted configuration and resume fingerprints. */
  resolution?: { origins: Record<string, string> };
};

/** Pure references check, shared by configuration loading and standalone assembly. */
export function assertServiceBindings(config: LoadedConfig): void {
  const experiment = config.experiment;
  const routes = [
    ["solver.service", experiment.solver.service],
    ["verifier.service", experiment.verifier?.service],
    ["benchmark.config.judgeService", experiment.benchmark.config.judgeService],
  ] as const;
  for (const [field, value] of routes) {
    if (value === undefined) continue;
    const name = expectNonEmptyString(value, field);
    if (!Object.hasOwn(experiment.services, name)) throw new TypeError(`${field} references unknown service ${name}`);
    if (!Object.hasOwn(config.auths, name)) throw new TypeError(`${field} service ${name} has no credentials`);
  }
}

/** Model and credential the solver selection names. */
export function solverBinding(config: LoadedConfig): { service: string; model: ModelConfig; auth: RuntimeAuth } {
  const service = config.experiment.solver.service;
  const model = config.experiment.services[service];
  const auth = config.auths[service];
  if (!model || !auth) throw new TypeError(`solver references unknown service ${service}`);
  return { service, model, auth };
}

export const DEFAULT_LOCAL_CONCURRENCY = 1;

export const DEFAULT_METRICS: readonly Selection[] = [
  { name: "success-rate", config: {} },
  { name: "duration", config: {} },
  { name: "usage", config: {} },
];

export const KNOWN_PROVIDERS = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai",
  "deepseek",
  "google",
  "groq",
  "mistral",
  "openai",
  "xai",
]);

export const KNOWN_APIS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${path} contains unknown field ${unknown}`);
  }
}

export function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

export function expectPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${path} must be a positive integer greater than zero`);
  }
  return value as number;
}

export function expectPositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive number`);
  }
  return value;
}

export function parseSelection(value: unknown, path: string): Selection {
  const record = expectRecord(value, path);
  rejectUnknown(record, ["name", "config"], path);
  const name = expectNonEmptyString(record.name, `${path}.name`);
  const config = record.config === undefined ? {} : expectRecord(record.config, `${path}.config`);
  return { name, config };
}

export function assertJsonValue(value: unknown, path = "configuration"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must contain only JSON values`);
}
