import { loadNetworkConfig } from "./network.js";
import { storedNetworkTemplate, restoreNetworkTemplate } from "./network-schema.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import type { JsonValue } from "../core/contracts/task.js";
import type { ConfigProfile } from "./profile-schema.js";
import type { PluginRole } from "../core/contracts/plugin.js";
import type { Selection } from "../core/contracts/config.js";
import { parseDeployment } from "./deployment.js";
import { parseJobsConfig } from "./jobs.js";
import { redactConfig } from "./redact.js";
import { parseEffectiveConfig, parseModel } from "./effective.js";
import { parseUserConfig } from "./user-schema.js";
import { resolveInput, type ConfigOrigins } from "./resolve.js";
import { assertJsonValue, expectRecord, expectNonEmptyString } from "../core/validation/input.js";
import { assertServiceBindings } from "../core/policies/service-bindings.js";
import { type CliOverrides, type EffectiveConfig, type ModelConfig, type RuntimeAuth } from "../core/contracts/config.js";
import { type LoadedConfig } from "./loaded.js";

function expandString(value: string, env: Record<string, string | undefined>, path: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = env[name];
    if (replacement === undefined) {
      throw new TypeError(`${path} references missing environment variable ${name}`);
    }
    return replacement;
  });
}

export function expandVariables(
  value: unknown,
  env: Record<string, string | undefined>,
  path = "configuration",
): unknown {
  if (typeof value === "string") return expandString(value, env, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => expandVariables(item, env, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandVariables(item, env, `${path}.${key}`)]),
    );
  }
  return value;
}

function parseAuth(
  model: Record<string, unknown>,
  env: Record<string, string | undefined>,
  sourceReference: string | null,
): { auth: RuntimeAuth; persistedReference: string } {
  if (model.apiKey !== undefined && model.apiKeyEnv !== undefined) {
    throw new TypeError("model.apiKey and model.apiKeyEnv cannot be used together");
  }

  if (model.apiKeyEnv !== undefined) {
    const name = expectNonEmptyString(model.apiKeyEnv, "model.apiKeyEnv");
    const value = env[name];
    if (value === undefined) {
      throw new TypeError(`model.apiKeyEnv references missing environment variable ${name}`);
    }
    if (value.trim() === "") throw new TypeError(`environment variable ${name} contains an empty API key`);
    return { auth: { value, reference: name }, persistedReference: `\${${name}}` };
  }

  const value = expectNonEmptyString(model.apiKey, "model.apiKey");
  if (value.trim() === "") throw new TypeError("model.apiKey must not be empty");
  return {
    auth: { value, reference: sourceReference },
    persistedReference: sourceReference === null ? "[runtime-provided]" : `\${${sourceReference}}`,
  };
}

function authReference(model: Record<string, unknown>): string | null {
  if (typeof model.apiKeyEnv === "string" && model.apiKeyEnv.trim() !== "") {
    return model.apiKeyEnv;
  }
  if (typeof model.apiKey === "string") {
    return /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(model.apiKey)?.[1] ?? null;
  }
  return null;
}

function persistedConfig(experiment: EffectiveConfig, references: Record<string, string>, original: Record<string, unknown>): JsonValue {
  const services = Object.fromEntries(
    Object.entries(experiment.services).map(([name, model]) => [
      name,
      { ...model, apiKey: references[name] ?? "[unresolved]" },
    ]),
  );
  const value = { ...experiment, services };
  assertJsonValue(value);
  const redacted = expectRecord(redactConfig(value), "persisted configuration");
  const redactedServices = expectRecord(redacted.services, "persisted configuration.services");
  for (const [name, model] of Object.entries(experiment.services)) {
    const redactedService = expectRecord(redactedServices[name], `persisted configuration.services.${name}`);
    redactedServices[name] = {
      ...redactedService,
      apiKey: references[name] ?? "[unresolved]",
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    };
  }
  assertJsonValue(redacted);
  return restoreSecretReferences(redacted, original);
}

/** Preserve references, not expanded credentials, in saved plugin configuration. */
function restoreSecretReferences(safe: JsonValue, original: unknown): JsonValue {
  if (safe === "[redacted]" && typeof original === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(original)) return original;
  if (Array.isArray(safe)) return safe.map((value, index) => restoreSecretReferences(value, Array.isArray(original) ? original[index] : undefined));
  if (safe === null || typeof safe !== "object" || original === null || typeof original !== "object" || Array.isArray(original)) return safe;
  const source = expectRecord(original, "original configuration");
  return Object.fromEntries(Object.entries(safe).map(([key, value]) => [key, restoreSecretReferences(value, source[key])]));
}

function resolveServiceAuth(
  model: Record<string, unknown>,
  env: Record<string, string | undefined>,
  path: string,
  required: boolean,
  allowMissingAuth: boolean,
): { model: ModelConfig; auth: RuntimeAuth | null; reference: string } {
  if (model.apiKey !== undefined && model.apiKeyEnv !== undefined) {
    throw new TypeError(`${path}.apiKey and ${path}.apiKeyEnv cannot be used together`);
  }
  const sourceReference = authReference(model);
  const referenced = typeof model.apiKey === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(model.apiKey)?.[1] : undefined;
  if (!required && referenced !== undefined && env[referenced] === undefined) {
    delete model.apiKey;
    const parsed = parseModel(expandVariables(model, env, path) as Record<string, unknown>);
    return { model: parsed, auth: null, reference: `\${${referenced}}` };
  }
  if (allowMissingAuth) {
    if (model.apiKeyEnv !== undefined) expectNonEmptyString(model.apiKeyEnv, `${path}.apiKeyEnv`);
    if (model.apiKey !== undefined) {
      const apiKey = expectNonEmptyString(model.apiKey, `${path}.apiKey`);
      if (apiKey.trim() === "") throw new TypeError(`${path}.apiKey must not be empty`);
    }
    delete model.apiKey;
    delete model.apiKeyEnv;
    const parsed = parseModel(expandVariables(model, env, path) as Record<string, unknown>);
    return {
      model: parsed,
      auth: { value: "", reference: sourceReference },
      reference: sourceReference === null ? "[runtime-provided]" : `\${${sourceReference}}`,
    };
  }
  const expanded = expandVariables(model, env, path) as Record<string, unknown>;
  if (model.apiKeyEnv !== undefined) expanded.apiKeyEnv = model.apiKeyEnv;
  const parsedAuth = parseAuth(expanded, env, sourceReference);
  return { model: parseModel(expanded), auth: parsedAuth.auth, reference: parsedAuth.persistedReference };
}

export async function readConfig(
  path: string,
  overrides: CliOverrides,
  env: Record<string, string | undefined>,
  options: ConfigReadOptions,
): Promise<LoadedConfig> {
  const absolutePath = resolve(path);
  const network = options.network ?? await loadNetworkConfig(options.networkConfigPath, env);
  const source = expectRecord(parse(await readFile(absolutePath, "utf8"), { maxAliasCount: 100 }), "configuration");
  const registry = options.registry;
  {
    const user = parseUserConfig(source);
    const benchmarkName = typeof user.benchmark === "string" ? user.benchmark : user.benchmark.name;
    const { source: normalized, origins } = resolveInput(absolutePath, user, registry.profiles(), overrides);
    const loaded = loadResolvedConfig(normalized, absolutePath, overrides, env, options, origins, registry);
    return attachNetwork(loaded, network, benchmarkName);
  }
}

export interface ConfigRegistry {
  profiles(): ConfigProfile[];
  validate(role: PluginRole, selection: Selection): void;
}
export type ConfigReadOptions = { networkConfigPath?: string; network?: import("../core/contracts/network.js").NetworkDocument; allowMissingAuth?: boolean; validatePlugins?: boolean; registry: ConfigRegistry; configDirectory?: string };

/** Internal, persisted execution configuration; never accepts public YAML shortcuts. */
export async function readSavedConfig(
  path: string,
  env: Record<string, string | undefined>,
  options: ConfigReadOptions,
): Promise<LoadedConfig> {
  const absolutePath = resolve(path);
  const source = expectRecord(parse(await readFile(absolutePath, "utf8"), { maxAliasCount: 100 }), "saved configuration");
  const savedNetwork = source.network === undefined ? undefined : expectRecord(source.network, "saved network");
  delete source.network;
  const network = options.network ?? (options.networkConfigPath || env.EVALUATOR_NETWORK_CONFIG || !savedNetwork
    ? await loadNetworkConfig(options.networkConfigPath, env) : restoreNetworkTemplate(savedNetwork.template, env));
  const benchmarkName = savedNetwork?.benchmarkName === undefined ? undefined : expectNonEmptyString(savedNetwork.benchmarkName, "saved benchmark name");
  const registry = options.registry;
  {
    return attachNetwork(loadResolvedConfig(source, absolutePath, {}, env, options, {}, registry), network, benchmarkName);
  }
}

function attachNetwork(loaded: LoadedConfig, network: import("../core/contracts/network.js").NetworkDocument, benchmarkName?: string): LoadedConfig {
  const name = benchmarkName ?? loaded.experiment.benchmark.name;
  const persisted = { ...expectRecord(loaded.persisted, "saved config"), network: { benchmarkName: name, template: storedNetworkTemplate(network.template) } };
  assertJsonValue(persisted);
  return { ...loaded, network, benchmarkName: name, persisted };
}

function loadResolvedConfig(
  normalized: Record<string, unknown>,
  absolutePath: string,
  overrides: CliOverrides,
  env: Record<string, string | undefined>,
  options: ConfigReadOptions,
  origins: ConfigOrigins,
  registry: ConfigRegistry,
): LoadedConfig {
  const deployment = normalized.deployment === undefined ? undefined : parseDeployment(normalized.deployment);
  const rawServices = expectRecord(normalized.services, "services");
  const solverService = expectNonEmptyString(expectRecord(normalized.solver, "solver").service, "solver.service");
  for (const [key, field] of [["model", "name"], ["endpoint", "endpoint"], ["apiKey", "apiKey"], ["apiKeyEnv", "apiKey"]] as const)
    if (overrides[key] !== undefined) origins[`services.${solverService}.${field}`] = "CLI override";
  const verifierService = normalized.verifier === undefined ? undefined : expectRecord(normalized.verifier, "verifier").service;
  const variables = { ...env, EVALUATOR_CACHE_DIR: env.EVALUATOR_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? (process.platform === "win32" ? env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") : join(homedir(), ".cache")), "ember-evaluator") };
  const judgeInput = expectRecord(expectRecord(normalized.benchmark, "benchmark").config, "benchmark.config").judgeService;
  const judgeService = judgeInput === undefined ? undefined : expectNonEmptyString(expandVariables(judgeInput, variables), "benchmark.config.judgeService");
  const services: Record<string, ModelConfig> = {};
  const auths: Record<string, RuntimeAuth> = {};
  const references: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawServices)) {
    const binding = resolveServiceAuth(expectRecord(value, `services.${name}`), variables, `services.${name}`,
      name === solverService || name === verifierService || name === judgeService, options.allowMissingAuth === true);
    services[name] = binding.model;
    references[name] = binding.reference;
    if (binding.auth) auths[name] = binding.auth;
  }
  if (!auths[solverService]) throw new TypeError(`solver service ${solverService} has no credentials`);
  const { services: _services, ...publicConfig } = normalized;
  const expanded = expectRecord(expandVariables(publicConfig, variables), "configuration");
  const experiment = parseEffectiveConfig({ ...expanded, services });
  if (deployment) {
    const { kind: _kind, ...connection } = deployment;
    parseJobsConfig({ ...connection, ...experiment.scheduler.config });
  }
  experiment.output.directory = resolve(options.configDirectory ?? dirname(absolutePath), experiment.output.directory);
  if (options.validatePlugins !== false) {
    const selections = ["benchmark", "environment", "solver", "scheduler", "store", "reporter"] as const;
    for (const role of selections) {
      if (role === "scheduler" && deployment) continue;
      registry.validate(role, experiment[role]);
    }
    if (experiment.verifier) registry.validate("verifier", experiment.verifier);
    for (const metric of experiment.metrics) registry.validate("metrics", metric);
  }
  const loaded = { ...(deployment === undefined ? {} : { deployment }), experiment, auths, persisted: persistedConfig(experiment, references, normalized), resolution: { origins } };
  assertServiceBindings(loaded);
  return loaded;
}
