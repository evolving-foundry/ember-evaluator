import { networkSecrets } from "../config/network-schema.js";
import { dirname, join, resolve } from "node:path";
import { createRunComponents, createBenchmark, createPluginRuntime } from "./plugins/create-components.js";
import { loadConfig } from "./config.js";
import { assertJsonValue } from "../core/validation/input.js";
import { solverBinding } from "../core/policies/service-bindings.js";
import { type CliOverrides } from "../core/contracts/config.js";
import { type LoadedConfig } from "../config/loaded.js";
import type { RunComponents } from "../core/contracts/components.js";
import type { ResultSnapshot } from "../core/contracts/result.js";
import { redactDiagnostic } from "../core/errors/diagnostics.js";
import { runEngine } from "./run-engine.js";
import { normalizeFailure } from "../core/errors/classify.js";
import type { ProgressEvent, ProgressListener } from "../core/progress/progress.js";
import { LiveOperation, safeProgress } from "../core/progress/live-progress.js";
import { resolveResumeRun } from "../core/recovery/resume.js";
import { ResumeError } from "../core/recovery/resume-error.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";
import { saveReport } from "./report/index.js";
import type { JobsExperimentResult } from "./ray/deployment.js";

export type EvaluationResult =
  | { kind: "local"; exitCode: number; runId: string; snapshot: ResultSnapshot; runDirectory: string; reportPath: string | null }
  | ({ kind: "ray-jobs" } & JobsExperimentResult);

export type EvaluatorRunOptions = {
  configPath: string;
  /** Explicit network YAML; otherwise EVALUATOR_NETWORK_CONFIG or ~/.ember-evaluator/network.yaml. */
  networkConfigPath?: string;
  patchPath?: string;
  overrides?: CliOverrides;
  /** Variables used to expand YAML and bind model credentials; does not replace process.env. */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** true selects the only existing run; a string selects a run ID. */
  resume?: boolean | string;
  onProgress?: ProgressListener;
};

export type ExecutionDiagnostic = { phase: string; error: unknown };
export type ExecutionOutcome = {
  exitCode: number;
  result: EvaluationResult | null;
  diagnostics: ExecutionDiagnostic[];
  secrets: string[];
};

export type LoadedExecution = { config: LoadedConfig; registry: PluginRegistry; runId?: string };

type ExecutionOptions = EvaluatorRunOptions & {
  taskIds?: string[];
  execution?: LoadedExecution;
  onLoaded?: (config: LoadedConfig) => void;
  onDiagnostic?: (diagnostic: ExecutionDiagnostic) => void;
  onDeploymentLog?: (text: string) => void;
};

/** Shared application workflow. The CLI owns process signals and presentation. */
export async function executeExperiment(options: ExecutionOptions): Promise<ExecutionOutcome> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const env = options.env ?? process.env;
  const overrides = options.overrides ?? {};
  const secrets = [overrides.apiKey ?? "", ...Object.entries(env)
    .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : [])];
  const diagnostics: ExecutionDiagnostic[] = [];
  let observerError: unknown;
  let observerPhase = "config";
  let observerFailed = false;
  let phase = "config";
  const observe = (callback: () => void) => {
    if (observerFailed) return;
    try { callback(); } catch (error) {
      observerFailed = true;
      observerError = error;
      observerPhase = phase;
      controller.abort(error);
      throw error;
    }
  };
  let globalOperation: LiveOperation | undefined;
  let globalPhase: string | undefined;
  const dispatchProgress = (event: ProgressEvent) => {
    const safe = { ...safeProgress(event, secrets),
      ...(event.failure ? { failure: normalizeFailure(event.failure, secrets) } : {}) };
    observe(() => options.onProgress?.(safe));
  };
  const progress = (event: ProgressEvent) => {
    if (event.taskId === undefined && !event.transient) {
      phase = event.phase;
      if (globalPhase !== event.phase) {
        globalOperation?.finish(signal.aborted ? "cancelled" : "completed");
        globalPhase = event.phase;
        globalOperation = ["source", "enumerate", "prepare"].includes(event.phase) ? undefined :
          new LiveOperation(dispatchProgress, { phase: event.phase, message: event.message }, secrets, undefined, "experiment");
      } else globalOperation?.update({ message: event.message });
    }
    dispatchProgress(event);
  };
  const diagnose = (error: unknown, at = phase) => {
    try { globalOperation?.finish(signal.aborted ? "cancelled" : "failed"); } catch { /* Observer errors are recorded below. */ }
    const diagnostic = { phase: at, error };
    diagnostics.push(diagnostic);
    // Diagnostic observers are CLI presentation; they cannot interrupt resource release.
    try { options.onDiagnostic?.(diagnostic); } catch (observer) { diagnostics.push({ phase: at, error: observer }); }
  };
  const file = resolve(options.configPath);
  const patchPath = options.patchPath === undefined ? undefined : resolve(options.patchPath);
  const resume = options.resume === undefined || options.resume === false ? undefined : options.resume === true ? null : options.resume;
  let registry: PluginRegistry | undefined = options.execution?.registry;
  let config: LoadedConfig | undefined;
  let components: RunComponents | undefined;
  let result: EvaluationResult | null = null;
  let exitCode = 2;
  let reportAttempted = false;
  const localResult = (snapshot: ResultSnapshot): EvaluationResult & { kind: "local" } => {
    if (!config) throw new Error("Configuration is not loaded");
    return { kind: "local", exitCode, runId: snapshot.run.runId, snapshot,
      runDirectory: join(config.experiment.output.directory, snapshot.run.runId), reportPath: null };
  };
  try {
    signal.throwIfAborted();
    progress({ phase: "config", message: `Loading and validating ${file}` });
    registry = options.execution?.registry ?? await openPluginRegistry(patchPath);
    config = options.execution?.config ?? await loadConfig(file, overrides, env, { registry,
      ...(options.networkConfigPath === undefined ? {} : { networkConfigPath: options.networkConfigPath }),
      ...(patchPath === undefined ? {} : { patchPath }) });
    secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value));
    options.onLoaded?.(config);
    if (options.taskIds !== undefined) {
      const run = { ...config.experiment.run };
      delete run.sampling;
      delete run.offset;
      config.experiment.run = { ...run, maxTasks: null, taskIds: [...options.taskIds] };
    }
    const experiment = config.experiment;
    progress({ phase: "bootstrap", message: `Initializing plugins: benchmark=${experiment.benchmark.name}, environment=${experiment.environment.name}, solver=${experiment.solver.name}, scheduler=${experiment.scheduler.name}; service=${experiment.solver.service}; model=${solverBinding(config).model.name}; endpoint=${solverBinding(config).model.endpoint ?? "provider default"}` });
    if (config.deployment) {
      const { RayJobsDeployment } = await import("./ray/deployment.js");
      const { parseJobsConfig } = await import("../config/jobs.js");
      await createBenchmark(registry, config, dirname(file));
      const { kind: _kind, ...connection } = config.deployment;
      const evaluator = registry.ctx.evaluator;
      const deployment = new RayJobsDeployment(parseJobsConfig({ ...connection, ...experiment.scheduler.config }),
        createPluginRuntime(config, dirname(file), patchPath), (role, name) => evaluator.configTransport(role, name));
      assertJsonValue(experiment);
      progress({ phase: "deployment", message: "Submitting and following the cluster evaluation job" });
      const jobs = await deployment.runExperiment(experiment, registry.pluginVersions, { signal, onProgress: progress,
        ...(resume === undefined ? {} : { resume }), log(text) {
          const message = redactDiagnostic(text, secrets);
          if (options.onDeploymentLog) observe(() => options.onDeploymentLog?.(message));
          else progress({ phase: "deployment", message });
        } });
      exitCode = jobs.exitCode;
      result = { kind: "ray-jobs", ...jobs,
        collectionError: jobs.collectionError === null ? null : redactDiagnostic(jobs.collectionError, secrets),
        reportError: jobs.reportError === null ? null : redactDiagnostic(jobs.reportError, secrets) };
      if (jobs.collectionError || jobs.reportError) {
        phase = jobs.collectionError ? "collect" : "report";
        if (exitCode === 0) exitCode = 1;
        diagnose(new Error(jobs.collectionError ?? jobs.reportError ?? "Ray Jobs result collection failed"));
      }
    } else {
      components = await createRunComponents(registry, config, dirname(file));
      if (resume !== undefined) progress({ phase: "resume", message: "Locating previous run" });
      const resumeDirectory = resume === undefined ? undefined : await resolveResumeRun(experiment.output.directory, resume);
      const snapshot = await runEngine({ components, config, signal, onProgress: progress,
        ...(options.execution?.runId ? { runId: options.execution.runId } : {}),
        ...(resumeDirectory === undefined ? {} : { resumeDirectory }) });
      exitCode = snapshot.run.status === "cancelled" ? 130 : snapshot.run.status === "completed" ? 0 : 1;
      const local = localResult(snapshot);
      result = local;
      reportAttempted = true;
      progress({ phase: "report", message: `Computing metrics and generating the report; run status=${snapshot.run.status}` });
      await saveReport(components.store, components.metrics, components.reporter, resume === undefined ? "update" : "resume");
      local.reportPath = join(local.runDirectory, "report.md");
    }
  } catch (error) {
    diagnose(error);
    exitCode = signal.aborted ? 130 : 2;
    if (components && !(error instanceof ResumeError)) {
      let snapshot: ResultSnapshot | undefined;
      try { snapshot = await components.store.snapshot(); } catch { /* No readable run was created. */ }
      const admittedRun = snapshot && (snapshot.run.source !== null || snapshot.run.failure?.code === "NETWORK_FAILURE");
      exitCode = signal.aborted ? 130 : admittedRun ? 1 : 2;
      if (snapshot) {
        const local = localResult(snapshot);
        result = local;
        if (!reportAttempted) {
          try {
            reportAttempted = true;
            progress({ phase: "report", message: "Saving partial results report after failure" });
            await saveReport(components.store, components.metrics, components.reporter, resume === undefined ? "update" : "resume");
            local.reportPath = join(local.runDirectory, "report.md");
          } catch (reportError) { diagnose(reportError); }
        }
      }
    }
  } finally {
    try { progress({ phase: "dispose", message: "Releasing runtime resources" }); } catch (error) { diagnose(error); }
    try { await registry?.dispose(); } catch (error) {
      diagnose(error, "dispose");
      if (exitCode !== 130) exitCode = 1;
    }
    try { globalOperation?.finish(signal.aborted ? "cancelled" : "completed"); } catch (error) { diagnose(error); }
  }
  if (observerFailed) {
    if (!diagnostics.some(diagnostic => diagnostic.error === observerError)) diagnose(observerError, observerPhase);
    exitCode = 1;
  }
  if (result) result.exitCode = exitCode;
  return { exitCode, result, diagnostics, secrets };
}
