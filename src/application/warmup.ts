import { networkSecrets } from "../config/network-schema.js";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { bootstrap, bootstrapBenchmark, createPluginRuntime } from "./plugins/bootstrap.js";
import { loadConfig } from "./config.js";
import type { CliOverrides } from "../core/contracts/config.js";
import type { LoadedConfig } from "../config/loaded.js";
import type { RunComponents } from "../core/contracts/components.js";
import type { Failure, PreparationRound } from "../core/contracts/result.js";
import type { TaskPlacement } from "../core/contracts/preparation.js";
import { createTaskPreparer } from "../core/preparation/materialize-task.js";
import { enumerateSelectedTasks } from "../core/selection/task-selection.js";
import { fingerprintConfig } from "../core/results/run-manifest.js";
import { progressOperation } from "../core/progress/progress-operation.js";
import { safeProgress } from "../core/progress/live-progress.js";
import { normalizeFailure } from "../core/errors/classify.js";
import type { ProgressListener } from "../core/progress/progress.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";
import { resolveSolverProvenance } from "../core/results/solver-provenance.js";
import { assertJsonValue } from "../core/validation/input.js";

export type WarmupSummary = {
  status: "ready" | "error";
  taskIds: string[];
  readyTaskIds: string[];
  failures: { taskId: string; failure: Failure }[];
  preparationRounds: PreparationRound[];
  placements: TaskPlacement[];
  durationMs: number;
};

/** Consume only preparation. No run store, attempt allocation, solver session or scoring. */
export async function warmupSelectedTasks(components: RunComponents, config: LoadedConfig, signal: AbortSignal,
  onProgress?: ProgressListener, sensitiveValues: readonly string[] = []): Promise<WarmupSummary> {
  signal.throwIfAborted();
  const remote = components.scheduler.executionLocation === "remote";
  if (remote && !components.scheduler.setupPreparation)
    throw new TypeError("Remote warmup requires scheduler.setupPreparation()");
  if (!components.benchmark.planRun || !components.scheduler.prepareTasks || (!remote && !components.environment.materialize))
    throw new TypeError("warmup requires benchmark.planRun(), scheduler.prepareTasks() and environment.materialize()");
  const started = performance.now();
  const source = await progressOperation(onProgress, { phase: "source", message: "Resolving dataset for image warmup" }, signal,
    activity => components.benchmark.resolveSource(null, signal, activity));
  const { selected } = await progressOperation(onProgress, { phase: "enumerate", message: "Selecting tasks for image warmup" }, signal,
    activity => enumerateSelectedTasks(components.benchmark, source, config.experiment.run, signal, activity));
  const taskIds = selected.map(ref => ref.id);
  const plan = await progressOperation(onProgress, { phase: "prepare", message: `Planning image warmup for ${selected.length} tasks` }, signal,
    activity => components.benchmark.planRun!(selected, source, signal, activity));
  const initialFailures = plan.preparationFailures ?? [];
  const failedIds = new Set(initialFailures.map(item => item.taskId));
  const plannedIds = [...plan.tasks.map(task => task.input.id), ...initialFailures.map(item => item.taskId)];
  const plannedSelection = selected.filter(ref => !failedIds.has(ref.id));
  const valid = new Set(taskIds);
  if (plannedIds.length !== selected.length || new Set(plannedIds).size !== selected.length || plannedIds.some(id => !valid.has(id)) ||
      plan.tasks.some((task, index) => task.input.id !== plannedSelection[index]?.id))
    throw new TypeError("Benchmark warmup plan differs from selected tasks");
  let preparationRounds: PreparationRound[] = [];
  let placements: TaskPlacement[] = [];
  const ready = new Set<string>();
  const failures = new Map(initialFailures.map(item => [item.taskId, item.failure]));
  const summary = (): WarmupSummary => ({ status: failures.size ? "error" : "ready", taskIds,
    readyTaskIds: taskIds.filter(id => ready.has(id)),
    failures: [...failures].map(([taskId, failure]) => ({ taskId, failure: normalizeFailure(failure, sensitiveValues) })),
    preparationRounds, placements, durationMs: performance.now() - started });
  if (failures.size && config.experiment.run.onError !== "continue") return summary();
  const runId = `warmup-${randomUUID()}`;
  const configFingerprint = fingerprintConfig(config.persisted);
  const jobs = plannedSelection.map(ref => ({ runId, taskId: ref.id, ref,
    attemptId: randomUUID(), configFingerprint }));
  if (!jobs.length) return summary();
  if (remote) {
    const solverProvenance = await resolveSolverProvenance(components.solver, signal, sensitiveValues);
    await components.scheduler.setupPreparation!({ session: { runId, source, configFingerprint,
      pluginVersions: components.pluginVersions, ...(solverProvenance ? { solverProvenance } : {}) },
      safeConfig: structuredClone(config.persisted), ...(onProgress ? { onProgress,
        log: message => onProgress({ phase: "prepare", message }) } : {}) }, signal);
  }
  const scheduled = await components.scheduler.prepareTasks(jobs, plan, {
    previous: [], sensitiveValues: [...sensitiveValues],
    ...(config.experiment.run.preparation ? { settings: config.experiment.run.preparation } : {}),
    ...(config.experiment.run.onError ? { onError: config.experiment.run.onError } : {}),
    ...(onProgress ? { onProgress } : {}),
    store: { async updateRun(patch) { if (patch.preparationRounds) preparationRounds = structuredClone(patch.preparationRounds); } },
    prepareTask: createTaskPreparer(components, { sensitiveValues, ...(onProgress ? { onProgress } : {}) }),
  }, signal);
  placements = scheduled.placements ?? [];
  if (scheduled.pipeline) {
    const pipeline = scheduled.pipeline;
    try {
      for await (const item of pipeline.tasks) {
        if (item.failure) failures.set(item.task.input.id, item.failure);
        else ready.add(item.task.input.id);
      }
      await pipeline.completion;
    } catch (error) {
      pipeline.cancel(error);
      await pipeline.completion.catch(() => {});
      throw error;
    }
  } else {
    for (const task of scheduled.tasks) ready.add(task.input.id);
    for (const item of plan.preparationFailures ?? []) failures.set(item.taskId, item.failure);
  }
  signal.throwIfAborted();
  if (ready.size + failures.size !== taskIds.length || [...ready].some(id => !valid.has(id) || failures.has(id)) ||
      [...failures.keys()].some(id => !valid.has(id)))
    throw new Error("Warmup preparation did not account for every selected task");
  return summary();
}

export async function executeWarmup(options: { configPath: string; networkConfigPath?: string; patchPath?: string; overrides?: CliOverrides;
  taskIds?: string[]; signal: AbortSignal; onProgress?: ProgressListener;
  execution?: { config: LoadedConfig; registry: PluginRegistry };
  onLoaded?: (config: LoadedConfig) => void }): Promise<WarmupSummary> {
  const file = resolve(options.configPath);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let registry: PluginRegistry | undefined;
  let components: RunComponents | undefined;
  const secrets = [options.overrides?.apiKey ?? "", ...Object.entries(process.env)
    .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : [])];
  const progress: ProgressListener = event => {
    try { options.onProgress?.(safeProgress(event, secrets)); }
    catch (error) { controller.abort(error); throw error; }
  };
  let failure: unknown;
  try {
    signal.throwIfAborted();
    progress({ phase: "config", message: `Loading warmup configuration ${file}` });
    registry = options.execution?.registry ?? await openPluginRegistry(options.patchPath);
    const config = options.execution?.config ?? await loadConfig(file, options.overrides ?? {}, process.env, { registry, allowMissingAuth: true,
      ...(options.networkConfigPath === undefined ? {} : { networkConfigPath: options.networkConfigPath }),
      ...(options.patchPath ? { patchPath: options.patchPath } : {}) });
    options.onLoaded?.(config);
    secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value).filter(Boolean));
    if (options.taskIds) {
      const run = { ...config.experiment.run, taskIds: options.taskIds, maxTasks: null };
      delete run.sampling; delete run.offset;
      config.experiment.run = run;
    }
    if (config.deployment) {
      const { RayJobsDeployment } = await import("./ray/deployment.js");
      const { parseJobsConfig } = await import("../config/jobs.js");
      await bootstrapBenchmark(config, dirname(file), options.patchPath, registry);
      const { kind: _kind, ...connection } = config.deployment;
      const deployment = new RayJobsDeployment(parseJobsConfig({ ...connection, ...config.experiment.scheduler.config }),
        createPluginRuntime(config, dirname(file), options.patchPath), (role, name) => registry!.ctx.evaluator.configTransport(role, name));
      assertJsonValue(config.experiment);
      return await deployment.warmupExperiment(config.experiment, registry.pluginVersions, { signal, onProgress: progress,
        log: message => progress({ phase: "deployment", message }) });
    }
    progress({ phase: "bootstrap", message: "Initializing plugins for image warmup" });
    components = await bootstrap(config, dirname(file), options.patchPath, undefined, registry);
    const release = components.scheduler.executionLocation === "remote" ? undefined : await components.environment.acquireImageLease?.(signal);
    let result: WarmupSummary;
    try { result = await warmupSelectedTasks(components, config, signal, progress, secrets); }
    finally { await release?.(); }
    progress({ phase: "prepare", message: `Image warmup completed: ${result.readyTaskIds.length}/${result.taskIds.length} tasks ready; ${result.failures.length} failed`, error: result.status === "error" });
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanupErrors: unknown[] = [];
    try { progress({ phase: "dispose", message: "Releasing warmup resources", transient: failure !== undefined }); } catch (error) { cleanupErrors.push(error); }
    for (const resource of [components, ...(options.execution ? [] : [registry])]) {
      try { await resource?.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "Warmup resource release failed");
  }
}
