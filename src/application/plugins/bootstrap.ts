import { NetworkRuntime } from "../../infrastructure/network/runtime.js";
import { resolve } from "node:path";

import { openPluginRegistry } from "./open-registry.js";
import { assertServiceBindings } from "../../core/policies/service-bindings.js";
import { type LoadedConfig } from "../../config/loaded.js";
import type { Benchmark } from "../../core/contracts/benchmark.js";
import type { Metrics } from "../../core/contracts/metrics.js";
import type { RunComponents, BenchmarkComponents } from "../../core/contracts/components.js";
import type { PluginRegistry } from "./open-registry.js";
import type { PluginFactoryContext } from "../../core/contracts/plugin.js";
import { fingerprintImageConfig } from "../../core/policies/image-config.js";
import type { ConfigTransportLookup } from "../../core/contracts/config-transport.js";

export function createPluginRuntime(config: LoadedConfig, experimentDir: string, pluginPatchPath?: string, onWarning?: (message: string) => void, configTransport?: ConfigTransportLookup, network = new NetworkRuntime(config.network)) {
  assertServiceBindings(config);
  const configDirectory = resolve(experimentDir);
  const services = Object.fromEntries(
    Object.entries(config.auths).map(([name, auth]) => {
      const model = config.experiment.services[name];
      if (!model) throw new TypeError(`missing model for service ${name}`);
      return [name, { model, auth }];
    }),
  );
  return {
    network,
    benchmarkName: config.benchmarkName ?? config.experiment.benchmark.name,
    hardware: config.experiment.hardware ?? "npu",
    phaseTimeouts: {
      ...(config.experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: config.experiment.run.solveTimeoutSeconds }),
      ...(config.experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: config.experiment.run.verifyTimeoutSeconds }),
    },
    imageConfigFingerprint: fingerprintImageConfig(config.experiment as unknown as import("../../core/contracts/task.js").JsonValue, configTransport),
    services,
    solverService: config.experiment.solver.service,
    environmentName: config.experiment.environment.name,
    configDirectory,
    ...(pluginPatchPath === undefined ? {} : { pluginPatchPath }),
    ...(onWarning === undefined ? {} : { onWarning }),
    resolvePath: (path: string) => resolve(configDirectory, path),
  };
}

async function createBenchmark(
  registry: PluginRegistry,
  config: LoadedConfig,
  runtime: PluginFactoryContext,
): Promise<Benchmark> {
  const createBenchmark = registry.ctx.evaluator.prepare("benchmark", config.experiment.benchmark);
  const createVerifier = config.experiment.verifier ? registry.ctx.evaluator.prepare("verifier", config.experiment.verifier) : undefined;
  const route = config.experiment.verifier?.service;
  const boundVerifier = route === undefined ? undefined : runtime.services[route];
  if (route !== undefined && !boundVerifier) throw new TypeError(`Verifier service ${route} is unavailable`);
  const verifier = createVerifier ? await createVerifier({ ...runtime,
    ...(route === undefined ? {} : { verifierService: route }) }) : undefined;
  const benchmark = await createBenchmark({ ...runtime, ...(verifier ? { verifier } : {}) });
  benchmark.validateRun?.(structuredClone(config.experiment));
  return benchmark;
}

export async function bootstrap(
  config: LoadedConfig,
  experimentDir: string,
  patchPath?: string,
  onWarning?: (message: string) => void,
  sharedRegistry?: PluginRegistry,
  imageConfigFingerprint?: string,
): Promise<RunComponents> {
  const reportingSelections = [
    ...config.experiment.metrics.map(selection => ({ role: "metrics" as const, name: selection.name })),
    { role: "reporter" as const, name: config.experiment.reporter.name },
  ];
  const registry = sharedRegistry ?? await openPluginRegistry(patchPath);
  const { ctx, patch, pluginVersions } = registry;
  const reportingProviders = Object.fromEntries(reportingSelections.flatMap(selection => {
    const key = `${selection.role}:${selection.name}`;
    const provider = registry.reportingProviders[key];
    return provider === undefined ? [] : [[key, provider]];
  }));
  try {
    // Resolve names and validate every private config before any factory can
    // allocate a workspace, start a process, or perform model I/O.
    const createEnvironment = ctx.evaluator.prepare("environment", config.experiment.environment);
    const createSolver = ctx.evaluator.prepare("solver", config.experiment.solver);
    const createMetrics = config.experiment.metrics.map(selection => ctx.evaluator.prepare("metrics", selection));
    const createReporter = ctx.evaluator.prepare("reporter", config.experiment.reporter);
    const createStore = ctx.evaluator.prepare("store", config.experiment.store);
    const createScheduler = ctx.evaluator.prepare("scheduler", config.experiment.scheduler);

    const runtime = { ...createPluginRuntime(config, experimentDir, patch.patchPath ?? undefined, onWarning, (role, name) => ctx.evaluator.configTransport(role, name)),
      ...(imageConfigFingerprint ? { imageConfigFingerprint } : {}) };
    registry.ctx.effect(() => () => runtime.network.dispose(), "Network client lifecycle");
    const benchmark = await createBenchmark(registry, config, runtime);
    const environment = await createEnvironment(runtime);
    const solver = await createSolver(runtime);
    const reportingRuntime = { configDirectory: runtime.configDirectory, resolvePath: runtime.resolvePath };
    const metrics: Metrics[] = [];
    for (const createMetric of createMetrics) metrics.push(await createMetric(reportingRuntime));
    const reporter = await createReporter(reportingRuntime);
    const store = await createStore(runtime);
    const scheduler = await createScheduler(runtime);
    let disposed = false;

    return {
      benchmark,
      environment,
      solver,
      metrics,
      reporter,
      store,
      scheduler,
      pluginVersions,
      pluginRuntime: {
        configDirectory: runtime.configDirectory,
        ...(patch.patchPath === null ? {} : { patchPath: patch.patchPath }),
        entries: structuredClone(patch.entries),
        reportingProviders,
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (!sharedRegistry) await registry.dispose();
      },
    };
  } catch (error) {
    if (!sharedRegistry) await registry.dispose();
    throw error;
  }
}

/** Create only the benchmark used to resolve and enumerate task IDs. */
export async function bootstrapBenchmark(
  config: LoadedConfig,
  experimentDir: string,
  patchPath?: string,
  sharedRegistry?: PluginRegistry,
): Promise<BenchmarkComponents> {
  const registry = sharedRegistry ?? await openPluginRegistry(patchPath);
  const { patch } = registry;
  try {
    const runtime = createPluginRuntime(config, experimentDir, patch.patchPath ?? undefined);
    registry.ctx.effect(() => () => runtime.network.dispose(), "Network client lifecycle");
    const benchmark = await createBenchmark(registry, config, runtime);
    let disposed = false;
    return {
      benchmark,
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (!sharedRegistry) await registry.dispose();
      },
    };
  } catch (error) {
    if (!sharedRegistry) await registry.dispose();
    throw error;
  }
}
