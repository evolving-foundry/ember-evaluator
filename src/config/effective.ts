import { DEFAULT_LOCAL_CONCURRENCY, DEFAULT_METRICS, KNOWN_APIS, KNOWN_PROVIDERS } from "./defaults.js";
import { expectRecord, rejectUnknown, expectNonEmptyString, expectPositiveInteger, parseSelection } from "../core/validation/input.js";
import { type EffectiveConfig, type ModelConfig, type Selection, type VerifierSelection } from "../core/contracts/config.js";
import { parseHardware } from "./hardware.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "../core/policies/timeouts.js";
import { preparationTimeoutMs } from "../core/preparation/preparation-timeout.js";

export function parseVerifierSelection(value: unknown): VerifierSelection {
  const selection = expectRecord(value, "verifier");
  rejectUnknown(selection, ["name", "config", "service"], "verifier");
  return { ...parseSelection({ name: selection.name, config: selection.config }, "verifier"),
    ...(selection.service === undefined ? {} : { service: expectNonEmptyString(selection.service, "verifier.service") }) };
}

function parseModelRetry(value: unknown): { maxAttempts: number } {
  const retry = expectRecord(value, "model.retry");
  rejectUnknown(retry, ["maxAttempts"], "model.retry");
  return { maxAttempts: expectPositiveInteger(retry.maxAttempts, "model.retry.maxAttempts") };
}

export function parseModel(model: Record<string, unknown>): ModelConfig {
  rejectUnknown(model, ["name", "endpoint", "provider", "api", "apiKey", "apiKeyEnv", "maxTokens", "contextWindow", "retry"], "model");
  const name = expectNonEmptyString(model.name, "model.name");
  const endpoint =
    model.endpoint === undefined || model.endpoint === null
      ? null
      : expectNonEmptyString(model.endpoint, "model.endpoint");
  const provider =
    model.provider === undefined || model.provider === null
      ? null
      : expectNonEmptyString(model.provider, "model.provider");
  const api = model.api === undefined || model.api === null ? null : expectNonEmptyString(model.api, "model.api");

  if (provider === null && api === null) {
    throw new TypeError("model must declare a recognized provider or API protocol");
  }
  if (provider !== null && !KNOWN_PROVIDERS.has(provider)) {
    throw new TypeError(`model.provider is not recognized: ${provider}`);
  }
  if (api !== null && !KNOWN_APIS.has(api)) {
    throw new TypeError(`model.api is not recognized: ${api}`);
  }
  // Preserve the old persisted shape and resume fingerprint when omitted.
  return {
    name,
    endpoint,
    provider,
    api,
    ...(model.maxTokens === undefined ? {} : { maxTokens: expectPositiveInteger(model.maxTokens, "model.maxTokens") }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: expectPositiveInteger(model.contextWindow, "model.contextWindow") }),
    ...(model.retry === undefined ? {} : { retry: parseModelRetry(model.retry) }),
  };
}

function parseRun(value: unknown, executionConcurrency: number, defaultPreparationMode: "batch" | "pipeline"): EffectiveConfig["run"] {
  if (value === undefined) {
    return { maxTasks: null, taskIds: null, timeoutSeconds: DEFAULT_TASK_TIMEOUT_SECONDS };
  }
  const run = expectRecord(value, "run");
  rejectUnknown(run, ["maxTasks", "offset", "taskIds", "timeoutSeconds", "solveTimeoutSeconds", "verifyTimeoutSeconds", "sampling", "onError", "includeTaskAnswer", "preparation"], "run");
  const maxTasks =
    run.maxTasks === undefined || run.maxTasks === null ? null : expectPositiveInteger(run.maxTasks, "run.maxTasks");
  const offset = run.offset;
  if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new TypeError("run.offset must be a non-negative safe integer");
  }
  let taskIds: string[] | null = null;
  if (run.taskIds !== undefined && run.taskIds !== null) {
    if (!Array.isArray(run.taskIds) || run.taskIds.length === 0) {
      throw new TypeError("run.taskIds must be a non-empty string array");
    }
    taskIds = run.taskIds.map((item, index) => expectNonEmptyString(item, `run.taskIds[${index}]`));
  }
  const timeoutSeconds =
    run.timeoutSeconds === undefined ? DEFAULT_TASK_TIMEOUT_SECONDS : expectPositiveInteger(run.timeoutSeconds, "run.timeoutSeconds");
  const phaseTimeouts = {
    ...(run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: expectPositiveInteger(run.solveTimeoutSeconds, "run.solveTimeoutSeconds") }),
    ...(run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: expectPositiveInteger(run.verifyTimeoutSeconds, "run.verifyTimeoutSeconds") }),
  };
  if (run.includeTaskAnswer !== undefined && typeof run.includeTaskAnswer !== "boolean") {
    throw new TypeError("run.includeTaskAnswer must be a boolean");
  }
  const includeTaskAnswer = run.includeTaskAnswer === true ? { includeTaskAnswer: true as const } : {};
  let preparation: EffectiveConfig["run"]["preparation"];
  if (run.preparation !== undefined) {
    const settings = expectRecord(run.preparation, "run.preparation");
    rejectUnknown(settings, ["mode", "concurrency", "lookahead", "environmentTimeoutSeconds", "roundTimeoutSeconds"], "run.preparation");
    const mode = settings.mode === undefined ? defaultPreparationMode : settings.mode;
    if (mode !== "batch" && mode !== "pipeline")
      throw new TypeError('run.preparation.mode must be "batch" or "pipeline"');
    const concurrency = settings.concurrency === undefined ? executionConcurrency : expectPositiveInteger(settings.concurrency, "run.preparation.concurrency");
    const lookahead = settings.lookahead === undefined ? undefined : expectPositiveInteger(settings.lookahead, "run.preparation.lookahead");
    if (lookahead !== undefined && (mode !== "pipeline" || lookahead < concurrency))
      throw new TypeError("run.preparation.lookahead requires pipeline mode and must be at least concurrency");
    const timeouts: { environmentTimeoutSeconds?: number; roundTimeoutSeconds?: number } = {};
    for (const key of ["environmentTimeoutSeconds", "roundTimeoutSeconds"] as const) {
      const value = settings[key];
      if (value === undefined) continue;
      if (typeof value !== "number") throw new TypeError(`run.preparation.${key} must be a positive number`);
      preparationTimeoutMs(value * (key === "environmentTimeoutSeconds" ? Math.min(concurrency, 10) : 1), `run.preparation.${key}`);
      timeouts[key] = value;
    }
    preparation = { mode, concurrency, ...(lookahead === undefined ? {} : { lookahead }), ...timeouts };
  }
  const optional = {
    ...phaseTimeouts,
    ...(offset === undefined ? {} : { offset }),
    ...includeTaskAnswer,
    ...(preparation === undefined ? {} : { preparation }),
  };
  let onError: "abort" | "continue" | undefined;
  if (run.onError !== undefined) {
    if (run.onError !== "abort" && run.onError !== "continue") {
      throw new TypeError('run.onError must be "abort" or "continue"');
    }
    onError = run.onError;
  }
  // Keep omitted optional fields absent so existing saved configuration fingerprints
  // are not changed merely by introducing them.
  if (run.sampling === undefined) {
    return onError === undefined
      ? { maxTasks, taskIds, timeoutSeconds, ...optional }
      : { maxTasks, taskIds, timeoutSeconds, onError, ...optional };
  }
  const sampling = expectRecord(run.sampling, "run.sampling");
  rejectUnknown(sampling, ["strategy", "seed"], "run.sampling");
  if (sampling.strategy !== "random") {
    throw new TypeError("run.sampling.strategy must be random; omit sampling for source order");
  }
  if (
    typeof sampling.seed !== "number" ||
    !Number.isInteger(sampling.seed) ||
    sampling.seed < 0 ||
    sampling.seed > 0xffff_ffff
  ) {
    throw new TypeError("run.sampling.seed must be an integer between 0 and 4294967295");
  }
  return {
    maxTasks,
    taskIds,
    timeoutSeconds,
    sampling: { strategy: "random", seed: sampling.seed },
    ...(onError === undefined ? {} : { onError }),
    ...optional,
  };
}

function parseMetrics(value: unknown): Selection[] {
  if (value === undefined) return DEFAULT_METRICS.map(({ name }) => ({ name, config: {} }));
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("metrics must be a non-empty selection array");
  }
  return value.map((selection, index) => parseSelection(selection, `metrics[${index}]`));
}

export function parseEffectiveConfig(source: Record<string, unknown>): EffectiveConfig {
  const services = Object.fromEntries(Object.entries(expectRecord(source.services, "services"))
    .map(([name, model]) => [name, parseModel(expectRecord(model, `services.${name}`))]));
  const solver = expectRecord(source.solver, "solver");
  rejectUnknown(solver, ["name", "config", "service"], "solver");
  const parsedSolver = { ...parseSelection({ name: solver.name, config: solver.config }, "solver"), service: expectNonEmptyString(solver.service, "solver.service") };
  if (!Object.hasOwn(services, parsedSolver.service)) throw new TypeError(`solver.service references unknown service ${parsedSolver.service}`);
  const verifier = source.verifier === undefined ? undefined : parseVerifierSelection(source.verifier);
  if (verifier?.service !== undefined && !Object.hasOwn(services, verifier.service)) throw new TypeError(`verifier.service references unknown service ${verifier.service}`);
  const output = expectRecord(source.output, "output");
  rejectUnknown(output, ["directory"], "output");
  const scheduler = source.scheduler === undefined ? { name: "local", config: { concurrency: DEFAULT_LOCAL_CONCURRENCY } } : parseSelection(source.scheduler, "scheduler");
  if (scheduler.name === "local" && scheduler.config.concurrency === undefined)
    scheduler.config.concurrency = DEFAULT_LOCAL_CONCURRENCY;
  if (scheduler.config.concurrency !== undefined) scheduler.config.concurrency = expectPositiveInteger(scheduler.config.concurrency, "scheduler.config.concurrency");
  return {
    hardware: parseHardware(source.hardware),
    services,
    benchmark: parseSelection(source.benchmark, "benchmark"),
    ...(verifier === undefined ? {} : { verifier }),
    solver: parsedSolver,
    environment: parseSelection(source.environment, "environment"),
    scheduler,
    metrics: parseMetrics(source.metrics),
    reporter: source.reporter === undefined ? { name: "markdown", config: {} } : parseSelection(source.reporter, "reporter"),
    store: source.store === undefined ? { name: "local", config: {} } : parseSelection(source.store, "store"),
    run: parseRun(source.run, typeof scheduler.config.concurrency === "number" ? scheduler.config.concurrency : 1,
      scheduler.name === "local" ? "pipeline" : "batch"),
    output: { directory: expectNonEmptyString(output.directory, "output.directory") },
  };
}
