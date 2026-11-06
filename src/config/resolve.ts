import { basename, extname, join } from "node:path";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "../core/policies/timeouts.js";
import { fileURLToPath } from "node:url";
import { parseEffectiveConfig } from "./effective.js";
import { parseDeployment } from "./deployment.js";
import { profileChain, validateProfiles, type ProfileLayer, type ResolvedProfiles } from "./profile-schema.js";
import { DEFAULT_LOCAL_CONCURRENCY } from "./defaults.js";
import { expectNonEmptyString, expectRecord } from "../core/validation/input.js";
import { type CliOverrides, type EffectiveConfig, type Selection } from "../core/contracts/config.js";
import { normalizeComponentSelection, normalizeSelection, parseUserConfig, type UserConfig } from "./user-schema.js";

export type ConfigOrigins = Record<string, string>;
export type ConfigResolution = { source: Record<string, unknown>; origins: ConfigOrigins };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Arrays replace; changing implementations or source kinds must not retain incompatible options. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return structuredClone(patch);
  const changedName = patch.name !== undefined && base.name !== undefined && patch.name !== base.name && ("config" in base || "config" in patch);
  if (changedName) return { ...Object.fromEntries(["solver", "verifier"].filter(key => Object.hasOwn(base, key)).map(key => [key, structuredClone(base[key])])), ...structuredClone(patch) };
  if (patch.kind !== undefined && base.kind !== undefined && patch.kind !== base.kind) return structuredClone(patch);
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(patch)])].map(key => [key,
    Object.hasOwn(patch, key) ? merge(base[key], patch[key]) : structuredClone(base[key])]));
}

function trace(value: unknown, path: string, origin: string, origins: ConfigOrigins): void {
  if (Array.isArray(value)) value.forEach((item, index) => trace(item, `${path}.${index}`, origin, origins));
  else if (isRecord(value) && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value)) trace(item, path ? `${path}.${key}` : key, origin, origins);
  } else origins[path] = origin;
}

function clearReplacedOrigins(base: unknown, patch: unknown, path: string, origins: ConfigOrigins): void {
  if (Array.isArray(patch) || !isRecord(patch) || (isRecord(base) && patch.kind !== undefined && base.kind !== undefined && patch.kind !== base.kind)) {
    for (const key of Object.keys(origins)) if (key === path || key.startsWith(`${path}.`)) delete origins[key];
    return;
  }
  if (!isRecord(base)) return;
  if (patch.name !== undefined && base.name !== undefined && patch.name !== base.name && ("config" in base || "config" in patch)) {
    for (const key of Object.keys(origins))
      if (key.startsWith(`${path}.config`) || key === `${path}.service`) delete origins[key];
  }
  for (const [key, item] of Object.entries(patch)) clearReplacedOrigins(base[key], item, path ? `${path}.${key}` : key, origins);
}

function partial(value: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(value);
  for (const role of ["environment", "scheduler", "store", "reporter"] as const)
    if (result[role] !== undefined) result[role] = normalizeComponentSelection(result[role], role);
  if (result.benchmark !== undefined) {
    const benchmark = typeof result.benchmark === "string" ? { name: result.benchmark } : expectRecord(result.benchmark, "benchmark");
    for (const role of ["solver", "verifier"])
      if (benchmark[role] !== undefined) benchmark[role] = normalizeSelection(benchmark[role], `benchmark.${role}`, [], true);
    result.benchmark = benchmark;
  }
  if (Array.isArray(result.metrics)) result.metrics = result.metrics.map((item, index) => normalizeSelection(item, `metrics[${index}]`));
  return result;
}

function defaultService(services: Record<string, unknown>): string {
  if (Object.hasOwn(services, "default")) return "default";
  const names = Object.keys(services);
  if (names.length === 1 && names[0]) return names[0];
  throw new TypeError("No default service: declare services.default or specify benchmark.solver.service");
}

export function applyOverrides(services: Record<string, unknown>, serviceName: string, overrides: CliOverrides): void {
  if (overrides.apiKey !== undefined && overrides.apiKeyEnv !== undefined) throw new TypeError("apiKey and apiKeyEnv CLI overrides cannot be used together");
  const model = expectRecord(services[serviceName], `services.${serviceName}`);
  if (overrides.model !== undefined) model.name = overrides.model;
  if (overrides.endpoint !== undefined) model.endpoint = overrides.endpoint;
  if (overrides.apiKey !== undefined) { model.apiKey = overrides.apiKey; delete model.apiKeyEnv; }
  if (overrides.apiKeyEnv !== undefined) { model.apiKeyEnv = overrides.apiKeyEnv; delete model.apiKey; }
}

function servicesInput(services: UserConfig["services"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(services).map(([name, model]) => {
    if (model.api_key !== undefined && (typeof model.api_key !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(model.api_key)))
      throw new TypeError(`services.${name}.api_key must reference an environment variable as \${NAME}`);
    return [name, { name: expectNonEmptyString(model.model, `services.${name}.model`),
      endpoint: expectNonEmptyString(model.base_url, `services.${name}.base_url`), api: model.api ?? "openai-completions",
      ...(model.api_key === undefined ? {} : { apiKey: model.api_key }),
      ...Object.fromEntries((["provider", "maxTokens", "contextWindow", "retry"] as const).filter(key => model[key] !== undefined).map(key => [key, model[key]])) }];
  }));
}

export function resolveInput(configPath: string, input: UserConfig, profiles: ResolvedProfiles, overrides: CliOverrides = {}): ConfigResolution {
  validateProfiles(profiles);
  const user = parseUserConfig(input);
  const benchmark = typeof user.benchmark === "string" ? { name: user.benchmark } : user.benchmark;
  const chain = profiles.some(profile => profile.role === "benchmark" && profile.id === benchmark.name)
    ? profileChain(profiles, "benchmark", benchmark.name) : [];
  const origins: ConfigOrigins = {};
  let source: Record<string, unknown> = {};
  const apply = (value: Record<string, unknown>, origin: string) => {
    const normalized = partial(value);
    clearReplacedOrigins(source, normalized, "", origins);
    source = expectRecord(merge(source, normalized), "configuration");
    trace(normalized, "", origin, origins);
  };
  apply({ hardware: "npu", benchmark: { name: benchmark.name, config: {}, solver: { name: "simpleagent", config: {} } },
    environment: { name: "docker", config: {} }, scheduler: { name: "local", config: { concurrency: DEFAULT_LOCAL_CONCURRENCY } },
    store: { name: "local", config: {} }, reporter: { name: "markdown", config: {} },
    metrics: ["success-rate", "duration", "usage"], run: { maxTasks: null, taskIds: null, timeoutSeconds: DEFAULT_TASK_TIMEOUT_SECONDS, onError: "continue" } }, "framework default");
  const aliases: Record<string, Selection> = {};
  const aliasOrigins: Record<string, string> = {};
  const applyLayer = (layer: ProfileLayer, origin: string, role: "benchmark" | "solver" = "benchmark") => {
    if (layer.defaults) apply(layer.defaults, origin);
    if (layer.plugin) apply(role === "benchmark" ? { benchmark: layer.plugin } : { benchmark: { solver: layer.plugin } }, origin);
    Object.assign(aliases, layer.metricAliases);
    for (const name of Object.keys(layer.metricAliases ?? {})) aliasOrigins[name] = origin;
  };
  const version = benchmark.version ?? chain.map(profile => profile.defaultVersion).filter(value => value !== undefined).at(-1);
  const scenario = benchmark.scenario ?? chain.map(profile => profile.defaultScenario).filter(value => value !== undefined).at(-1);
  for (const [selector, selected] of [["versions", version], ["scenarios", scenario]] as const) {
    if (selected !== undefined && !chain.some(profile => Object.hasOwn(profile[selector] ?? {}, selected)))
      throw new TypeError(`unknown ${selector === "versions" ? "version" : "scenario"} ${selected} for benchmark ${benchmark.name}`);
  }
  for (const profile of chain) {
    applyLayer(profile, `profile ${profile.id}`);
    if (version !== undefined && profile.versions?.[version]) applyLayer(profile.versions[version], `profile ${profile.id}@${version}`);
    if (scenario !== undefined && profile.scenarios?.[scenario]) applyLayer(profile.scenarios[scenario], `profile ${profile.id}/${scenario}`);
  }
  // Solver profiles have lower precedence than user YAML, including the selected solver's private config.
  const baselineSolver = expectRecord(source.benchmark, "benchmark").solver;
  const baselineSolverOrigin = origins["benchmark.solver.name"] ?? "framework default";
  const selectedSolver = benchmark.solver === undefined ? baselineSolver : merge(baselineSolver, normalizeSelection(benchmark.solver, "benchmark.solver", [], true));
  const solverName = normalizeSelection(selectedSolver, "benchmark.solver", [], true).name;
  const solverProfiles = solverName !== undefined && profiles.some(profile => profile.role === "solver" && profile.id === solverName)
    ? profileChain(profiles, "solver", solverName) : [];
  for (const profile of solverProfiles) applyLayer(profile, `solver profile ${profile.id}`, "solver");
  if (solverProfiles.length) {
    const selected = normalizeSelection(selectedSolver, "benchmark.solver", [], true);
    const implementation = expectRecord(expectRecord(source.benchmark, "benchmark").solver, "solver").name;
    const implementationOrigin = origins["benchmark.solver.name"];
    apply({ benchmark: { solver: { ...selected, name: implementation } } }, baselineSolverOrigin);
    if (implementationOrigin) origins["benchmark.solver.name"] = implementationOrigin;
  }
  const canonicalName = expectRecord(source.benchmark, "benchmark").name;
  const benchmarkNameOrigin = origins["benchmark.name"];
  const { name: _name, version: _version, scenario: _scenario, ...benchmarkOptions } = benchmark;
  if (benchmarkOptions.solver !== undefined && solverProfiles.length) {
    const selection = normalizeSelection(benchmarkOptions.solver, "benchmark.solver", [], true);
    benchmarkOptions.solver = selection.name === undefined ? selection : { ...selection,
      name: expectNonEmptyString(expectRecord(expectRecord(source.benchmark, "benchmark").solver, "solver").name, "solver.name") };
  }
  apply({ ...user, benchmark: { name: canonicalName, ...benchmarkOptions } }, "user YAML");
  if (canonicalName !== benchmark.name && benchmarkNameOrigin) origins["benchmark.name"] = benchmarkNameOrigin;
  const resolvedBenchmark = expectRecord(source.benchmark, "benchmark");
  const { solver: rawSolver, verifier: rawVerifier, ...pluginBenchmark } = resolvedBenchmark;
  const solver = normalizeSelection(rawSolver, "benchmark.solver", [], true);
  const services = servicesInput(user.services);
  const service = solver.service ?? defaultService(services);
  if (!Object.hasOwn(services, service)) throw new TypeError(`solver.service references unknown service ${service}`);
  if (solver.service === undefined) origins["solver.service"] = "framework default";
  let verifier: Record<string, unknown> | undefined;
  if (rawVerifier !== undefined) {
    verifier = { ...normalizeSelection(rawVerifier, "benchmark.verifier", [], true) };
    if (verifier.service === "$default") verifier.service = defaultService(services);
  }
  const rawMetrics = source.metrics;
  if (!Array.isArray(rawMetrics) || !rawMetrics.length) throw new TypeError("metrics must be a non-empty selection array");
  const metrics = rawMetrics.map((item, index) => {
    const metric = normalizeSelection(item, `metrics[${index}]`);
    const alias = metric.name === undefined ? undefined : aliases[metric.name];
    if (!alias) return metric;
    const previous = Object.fromEntries(Object.entries(origins).filter(([path]) => path.startsWith(`metrics.${index}.`)));
    trace(alias, `metrics.${index}`, aliasOrigins[metric.name ?? ""] ?? "profile metric alias", origins);
    Object.assign(origins, previous);
    return merge(alias, { ...metric, name: alias.name });
  });
  const output = expectRecord(source.output ?? {}, "output");
  if (output.directory === undefined) {
    const label = benchmark.name;
    if (!/^[A-Za-z0-9_.-]+$/u.test(label) || label === "." || label === "..") throw new TypeError("benchmark profile name must be a safe output directory name or supply output.directory");
    const filename = basename(configPath, extname(configPath));
    // src/config and dist/config are both two levels below the Evaluator package root.
    output.directory = join(fileURLToPath(new URL("../../", import.meta.url)), "results", label, filename);
    origins["output.directory"] = "generated";
  }
  source = { ...source, services, benchmark: pluginBenchmark, solver: { ...solver, service },
    ...(verifier === undefined ? {} : { verifier }), metrics, output };
  for (const [path, origin] of Object.entries({ ...origins })) {
    for (const role of ["solver", "verifier"])
      if (path.startsWith(`benchmark.${role}.`)) origins[path.slice("benchmark.".length)] = origin;
  }
  for (const [name, field] of [["model", "name"], ["endpoint", "endpoint"], ["apiKey", "apiKey"], ["apiKeyEnv", "apiKey"]] as const)
    if (overrides[name] !== undefined) origins[`services.${service}.${field}`] = "CLI override";
  for (const name of Object.keys(services)) {
    for (const [publicKey, effectiveKey] of [["model", "name"], ["base_url", "endpoint"], ["api_key", "apiKey"]]) {
      const origin = origins[`services.${name}.${publicKey}`];
      if (origin && origins[`services.${name}.${effectiveKey}`] !== "CLI override") origins[`services.${name}.${effectiveKey}`] = origin;
    }
  }
  applyOverrides(services, service, overrides);
  const scheduler = expectRecord(source.scheduler, "scheduler");
  const scheduling = expectRecord(scheduler.config, "scheduler.config");
  // Public Ray shorthand uses the packaged local cluster. Saved coordinator configs
  // bypass this resolver, so they never submit a second deployment.
  if (source.deployment === undefined && scheduler.name === "ray" && scheduling.endpoint === undefined) {
    source.deployment = parseDeployment({ kind: "ray-jobs", managedLocal: true });
    trace(source.deployment, "deployment", "framework default", origins);
  }
  if (source.deployment !== undefined) {
    if (scheduler.name !== "ray") throw new TypeError("Ray Jobs deployment requires scheduler: ray");
    for (const key of Object.keys(scheduling))
      if (key !== "concurrency" && key !== "nodes") throw new TypeError(`scheduler.config.${key} belongs to the coordinator; Jobs connection settings belong in deployment`);
  }
  return { source, origins };
}

/** Resolve public defaults without I/O. Authentication and environment expansion belong to loadConfig. */
export function resolveConfig(configPath: string, userConfig: UserConfig, profiles: ResolvedProfiles, overrides: CliOverrides = {}): EffectiveConfig {
  const { source } = resolveInput(configPath, userConfig, profiles, overrides);
  const services = Object.fromEntries(Object.entries(expectRecord(source.services, "services")).map(([name, value]) => {
    const { apiKey: _key, apiKeyEnv: _env, ...model } = expectRecord(value, `services.${name}`);
    return [name, model];
  }));
  return parseEffectiveConfig({ ...source, services });
}
