import type { RetryControlService, RetryController, RetryRequest, RetryAdmission } from "../contracts/retry-control.js";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RunComponents } from "../contracts/components.js";
import { solverBinding } from "../policies/service-bindings.js";
import { type ExecutionConfig } from "../contracts/config.js";
import type { AttemptRecord, Failure, ResultSnapshot, RunManifest } from "../contracts/result.js";
import type { TaskExecutor, TaskJob } from "../contracts/scheduler.js";
import { fingerprintConfig, fingerprintResumeConfig } from "../results/run-manifest.js";
import { runTask } from "./run-task.js";
import { createTaskPreparer } from "../preparation/materialize-task.js";
import { preparationConcurrency } from "../preparation/preparation-timeout.js";
import type { PreparationPipeline } from "../contracts/preparation.js";
import { prepareDispatch } from "../preparation/prepare-dispatch.js";

import { resolveRunStatus } from "../results/task-result-resolver.js";
import { TaskQueue } from "./task-queue.js";
import { isManualRetryEligible } from "../recovery/manual-retry.js";
import { isStreamTaskRetryEligible, MAX_STREAM_TASK_RETRIES } from "../recovery/automatic-task-retry.js";
import { assertResumePluginVersions, planResume } from "../recovery/resume.js";
import { ResumeError } from "../recovery/resume-error.js";
import { enumerateSelectedTasks } from "../selection/task-selection.js";
import { assertResumeSolverProvenance, resolveSolverProvenance } from "../results/solver-provenance.js";
import type { ProgressListener } from "../progress/progress.js";
import { progressOperation } from "../progress/progress-operation.js";
import type { SourceLock, PreparedTask } from "../contracts/task.js";
import { attemptStatus, attemptTimeoutKind, evaluationScore, hasUnconfirmedCleanup, isAgentTimeout, isEvaluationComplete } from "../results/evaluation-outcome.js";
import { formatError, redactDiagnostic } from "../errors/diagnostics.js";
import { classifyError, failureMessage } from "../errors/classify.js";
import { requiresDispatchStop } from "../policies/error-policy.js";
import { EvaluatorError } from "../errors/evaluator-error.js";

export type EngineExecutionInput = {
  components: RunComponents;
  config: ExecutionConfig;
  signal: AbortSignal;
  resumeDirectory?: string;
  onProgress?: ProgressListener;
  runId?: string;
  retryTaskIds?: string[];
  retryRequestId?: string;
};

function warnRetryControl(input: EngineExecutionInput, error: unknown): void {
  input.onProgress?.({ phase: "retry", warning: true,
    message: `Manual retry control failed; evaluation continues. ${redactDiagnostic(formatError(error), Object.values(input.config.auths).map(auth => auth.value))}` });
}

async function admitRetryRequests(
  requests: RetryRequest[],
  store: RunComponents["store"],
  originals: ReadonlyMap<string, TaskJob>,
  queue: TaskQueue,
): Promise<RetryAdmission> {
  const reservations: RetryAdmission[] = [];
  try {
    const records = (await store.snapshot()).records;
    for (const request of requests) {
      for (const record of records.filter(item => isManualRetryEligible(item) && (!request.taskIds.length || request.taskIds.includes(item.key.taskId)))) {
        const original = originals.get(record.key.taskId);
        const reservation = original ? queue.reserve({ ...original, attemptId: randomUUID() }, record.key.attemptId) : undefined;
        if (reservation) {
          reservations.push(reservation);
          request.bindings = { ...request.bindings, [record.key.taskId]: record.key.attemptId };
        }
      }
      request.status = Object.keys(request.bindings).length ? "accepted" : "rejected";
      request.message = request.status === "rejected" ? "No eligible idle network failures" : "Admitted by coordinator";
    }
    return {
      commit: () => {
        for (const item of reservations) item.commit();
      },
      release: () => {
        for (const item of reservations) item.release();
      },
    };
  } catch (error) {
    for (const item of reservations) item.release();
    throw error;
  }
}

type RetryPreparation = { task?: PreparedTask; failure?: Failure };

async function prepareRetryTask(
  job: TaskJob,
  initialAttemptId: string | undefined,
  { components, source, signal, run, sensitiveValues, onProgress }: {
    components: RunComponents;
    source: SourceLock;
    signal: AbortSignal;
    run: ExecutionConfig["experiment"]["run"];
    sensitiveValues: readonly string[];
    onProgress: ProgressListener;
  },
): Promise<RetryPreparation | undefined> {
  if (initialAttemptId === job.attemptId || !components.benchmark.planRun) return undefined;
  const planRun = components.benchmark.planRun.bind(components.benchmark);
  const plan = await progressOperation(onProgress, {
    phase: "prepare", message: "Replanning task environments", taskId: job.taskId, attemptId: job.attemptId,
  }, signal, activity => planRun([job.ref], source, signal, activity));
  const rejected = plan.preparationFailures?.find(item => item.taskId === job.taskId);
  if (rejected) return { failure: rejected.failure };
  try {
    const history = (await components.store.snapshot()).run.preparationRounds ?? [];
    if (!components.scheduler.prepareTasks) throw new Error("Scheduler must implement prepareTasks() for planned retries");
    const prepared = await components.scheduler.prepareTasks([job], plan, {
      previous: history,
      settings: { mode: "batch", concurrency: 1,
        ...(run.preparation?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: run.preparation.environmentTimeoutSeconds }),
        ...(run.preparation?.roundTimeoutSeconds === undefined ? {} : { roundTimeoutSeconds: run.preparation.roundTimeoutSeconds }) },
      sensitiveValues, onProgress, store: components.store,
      prepareTask: createTaskPreparer(components, { sensitiveValues, onProgress }),
    }, signal);
    if (prepared.pipeline) {
      prepared.pipeline.cancel(new Error("Retry preparation requires a batch barrier"));
      await prepared.pipeline.completion;
      throw new Error("Scheduler returned streaming preparation for a batch retry");
    }
    const task = prepared.tasks[0];
    const failure = plan.preparationFailures?.find(item => item.taskId === job.taskId)?.failure;
    return { ...(task ? { task } : {}), ...(failure ? { failure } : {}) };
  } catch (error) {
    return { failure: classifyError(error, { phase: "prepare", component: "environment", secrets: sensitiveValues }) };
  }
}

export async function executeEngine({
  components,
  config,
  signal,
  resumeDirectory,
  onProgress,
  retryTaskIds,
  retryRequestId,
  runId,
}: EngineExecutionInput, retryControl: RetryControlService, loadIdentity: () => Promise<import("../contracts/result.js").RunIdentity>): Promise<ResultSnapshot> {
  let control: RetryController | undefined;
  components.benchmark.validateRun?.(structuredClone(config.experiment));
  const progress = (phase: string, message: string) => onProgress?.({ phase, message });
  const started = performance.now();
  if (typeof components.scheduler.executeReady !== "function") throw new TypeError("Scheduler must implement executeReady() for dynamic attempt admission");
  const batchPreparation = components.benchmark.planRun !== undefined;
  const preparation = config.experiment.run.preparation;
  const streaming = preparation?.mode === "pipeline";
  if (streaming && (!batchPreparation || components.scheduler.executionLocation === "remote"))
    throw new Error("Pipeline preparation requires benchmark.planRun() and a local scheduler supporting executeReady()");
  signal.throwIfAborted();
  if (resumeDirectory !== undefined) progress("resume", `Opening and validating ${resumeDirectory}`);
  const previous = resumeDirectory === undefined ? null : await components.store.open(resumeDirectory);
  const sourceWasLocked = Boolean(previous?.source);
  if (previous && previous.evaluationKind !== (components.benchmark.evaluationKind ?? "quality"))
    throw new ResumeError("SOURCE_CHANGED", "Resume evaluation kind differs from the original run");
  const previousAttempts = previous ? await components.store.listAttempts() : [];
  const unconfirmedAttempts = previousAttempts.filter(attempt => attempt.record && hasUnconfirmedCleanup(attempt.record));
  const resume = previous ? planResume(previous, previousAttempts, fingerprintResumeConfig(config.persisted)) : null;
  const bound = solverBinding(config);
  const solverProvenance = await resolveSolverProvenance(components.solver, signal, [bound.auth.value], previous?.solverProvenance);
  if (previous) assertResumeSolverProvenance(previous.solverProvenance, solverProvenance);
  const elapsed = () =>
    previous ? Math.max(0, Date.now() - Date.parse(previous.startedAt)) : performance.now() - started;
  if (previous) {
    if (!Number.isFinite(Date.parse(previous.startedAt)))
      throw new ResumeError("STORE_RECORD_INVALID", "Invalid original run start time");
    assertResumePluginVersions(previous.pluginVersions, components.pluginVersions);
    if (previous.source !== null && (retryTaskIds ?? resume!.restartTaskIds).length === 0 && unconfirmedAttempts.length === 0) {
      if (components.benchmark.validateSourceOnCompletedResume && previous.source) {
        const lockedSource = previous.source;
        const current = await progressOperation(onProgress, { phase: "source", message: `Validating locked source ${lockedSource.source}` }, signal,
          activity => components.benchmark.resolveSource(lockedSource, signal, activity));
        if (fingerprintConfig(current) !== fingerprintConfig(previous.source))
          throw new ResumeError("SOURCE_CHANGED", "Resume source differs from the locked source");
      }
      const snapshot = await components.store.snapshot();
      const status = resolveRunStatus(snapshot);
      if (snapshot.run.status !== status)
        await components.store.updateRun({ status, finishedAt: new Date().toISOString(), durationMs: elapsed() });
      return await components.store.snapshot();
    }
  }
  if (previous && batchPreparation !== (previous.executionVersion === 2))
    throw new ResumeError("SOURCE_CHANGED", "Per-attempt and batch preparation runs cannot resume across execution versions");
  const experiment = config.experiment;
  const configSummary = JSON.parse(
    JSON.stringify(
      {
        model: bound.model.name,
        api: bound.model.api,
        provider: bound.model.provider,
        hardware: experiment.hardware ?? "npu",
        benchmark: experiment.benchmark.name,
        environment: experiment.environment.name,
        solver: experiment.solver.name,
        scheduler: experiment.scheduler.name,
        metrics: experiment.metrics.map(metric => metric.name),
        reporter: experiment.reporter.name,
        run: experiment.run,
      },
      (_key, value: unknown) =>
        typeof value === "string" && bound.auth.value ? value.replaceAll(bound.auth.value, "[redacted]") : value,
    ),
  );
  const manifest: RunManifest = previous ?? {
    schemaVersion: 1,
    evaluationKind: components.benchmark.evaluationKind ?? "quality",
    ...(batchPreparation ? { executionVersion: 2 as const } : {}),
    runId: runId ?? randomUUID(),
    source: null,
    taskIds: [],
    configFingerprint: fingerprintResumeConfig(config.persisted),
    pluginVersions: components.pluginVersions,
    configSummary,
    identity: await loadIdentity(),
    ...(solverProvenance === undefined ? {} : { solverProvenance }),
    ...(components.pluginRuntime ? { pluginRuntime: structuredClone(components.pluginRuntime) } : {}),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    status: "running",
  };
  progress("store", `Initializing run ${manifest.runId}; output=${config.experiment.output.directory}`);
  if (!previous) await components.store.create(config.experiment.output.directory, manifest, config.persisted);
  if (retryRequestId && components.store.controlDirectory) {
    await retryControl.claim(components.store.controlDirectory, retryRequestId, async () => {
      const bindings: Record<string, string> = {};
      for (const record of (await components.store.snapshot()).records.filter(isManualRetryEligible))
        if (!retryTaskIds || retryTaskIds.includes(record.key.taskId)) bindings[record.key.taskId] = record.key.attemptId;
      return bindings;
    });
  }
  const warnControl = (error: unknown) => warnRetryControl({ components, config, signal, ...(onProgress ? { onProgress } : {}) }, error);
  if (components.store.controlDirectory) {
    try { control = await retryControl.start(components.store.controlDirectory, warnControl); }
    catch (error) { warnControl(error); }
  }
  let source: SourceLock;
  let selected;
  try {
    source = await progressOperation(onProgress, { phase: "source", message: `Preparing dataset ${config.experiment.benchmark.name} (checking the cache and downloading as needed)` }, signal,
      activity => components.benchmark.resolveSource(previous?.source ?? null, signal, activity));
    if (previous?.source && fingerprintConfig(source) !== fingerprintConfig(previous.source))
      throw new ResumeError("SOURCE_CHANGED", "Resume source differs from the locked source");
    const selection = await progressOperation(onProgress, { phase: "enumerate", message: `Reading tasks from ${source.source} revision=${source.revision}` }, signal,
      activity => enumerateSelectedTasks(components.benchmark, source, config.experiment.run, signal, activity));
    selected = selection.selected;
    if (previous?.source && fingerprintConfig(selected.map(ref => ref.id)) !== fingerprintConfig(previous.taskIds))
      throw new ResumeError("SOURCE_CHANGED", "Resume source enumeration differs from the locked task selection");
    if (!manifest.source) {
      await components.store.updateRun({ source, taskIds: selected.map(ref => ref.id), failure: null });
      manifest.source = source; manifest.taskIds = selected.map(ref => ref.id);
    } else await components.store.updateRun({ failure: null });
  } catch (error) {
    const failure = classifyError(error, { phase: "prepare", component: "source", secrets: Object.values(config.auths).map(auth => auth.value) });
    failure.details.logPath = "manifest.json";
    onProgress?.({ phase: "source", error: true, failure, message: failureMessage(failure) });
    await components.store.updateRun({ status: signal.aborted ? "cancelled" : "error", finishedAt: new Date().toISOString(),
      durationMs: elapsed(), failure, initializationFailures: [...(previous?.initializationFailures ?? []), failure] });
    if (error instanceof ResumeError || failure.code !== "NETWORK_FAILURE") throw error;
    return await components.store.snapshot();
  }
  const current = previous ? (await components.store.snapshot()).records : [];
  const eligible = new Set(current.filter(isManualRetryEligible).map(record => record.key.taskId));
  if (retryTaskIds?.some(id => !eligible.has(id))) throw new Error("Retry selection contains a task without a current network failure");
  const restart = retryTaskIds ? new Set(retryTaskIds) : sourceWasLocked ? new Set(resume!.restartTaskIds) : null;
  const jobs: TaskJob[] = selected.filter(ref => restart === null || restart.has(ref.id)).map(ref => ({
    runId: manifest.runId, taskId: ref.id, attemptId: randomUUID(), ref, configFingerprint: manifest.configFingerprint,
  }));
  const taskNumbers = new Map(selected.map((ref, index) => [ref.id, index + 1]));
  const preparedTaskIds = new Set<string>();
  const completedTaskIds = new Set(current.filter(record => !jobs.some(job => job.taskId === record.key.taskId)).map(record => record.key.taskId));
  const taskProgress: ProgressListener = event => {
    const taskNumber = event.taskId === undefined ? undefined : taskNumbers.get(event.taskId);
    if (event.taskId && event.live?.status === "started") completedTaskIds.delete(event.taskId);
    if (event.taskId && event.live?.status === "completed" && event.live.preparation) preparedTaskIds.add(event.taskId);
    onProgress?.({ ...event, summary: { total: selected.length, prepared: preparedTaskIds.size, completed: completedTaskIds.size },
      ...(taskNumber === undefined ? {} : { taskNumber, taskTotal: selected.length }) });
  };
  const sensitiveValues = [...Object.values(config.auths).map(auth => auth.value)];
  const savePreparationFailure = async (job: TaskJob, error: unknown) => {
    const message = redactDiagnostic(formatError(error), sensitiveValues);
    const record = await runTask(job, components, source, signal, {
      preparationFailure: classifyError(error, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED", secrets: sensitiveValues }),
      sensitiveValues, onProgress: taskProgress,
    });
    taskProgress({ phase: "prepare", taskId: job.taskId, attemptId: job.attemptId, error: true,
      ...(record.errors[0] ? { failure: record.errors[0] } : {}), message: `Environment preparation failed; task is invalid: ${message}` });
    return record;
  };
  let pipeline: PreparationPipeline | undefined;
  let taskQueue: TaskQueue | undefined;
  let releaseImages: (() => Promise<void>) | undefined;
  try {
    if (components.scheduler.executionLocation !== "remote") releaseImages = await components.environment.acquireImageLease?.(signal);
    if (previous) await components.store.updateRun({ status: "running", finishedAt: null });
    progress("scheduler", `Setting up scheduler ${config.experiment.scheduler.name}`);
    // A task-level failure aborts this controller (run.onError=abort), cancelling
    // in-flight attempts through the scheduler's own abort handling while the
    // user-facing signal stays untouched so the run finalizes as "error".
    const runController = new AbortController();
    const schedulerSignal = AbortSignal.any([signal, runController.signal]);
    await components.scheduler.setup?.(
      {
        // Preserve the original manifest, but dispatch this session with the current code/runtime.
        run: { ...manifest, pluginVersions: components.pluginVersions,
          ...(solverProvenance === undefined ? {} : { solverProvenance }), status: "running", finishedAt: null },
        safeConfig: structuredClone(config.persisted),
        store: components.store,
        log: message => progress("execute", message),
        ...(onProgress ? { onProgress: taskProgress } : {}),
      },
      schedulerSignal,
    );
    components.scheduler.validateCapacity?.(jobs.length);
    if (restart) {
      progress("recover", "Recovering interrupted environments");
      const keys = previousAttempts.filter(attempt => restart.has(attempt.key.taskId) ||
        attempt.record && hasUnconfirmedCleanup(attempt.record)).map(attempt => attempt.key);
      // Distributed schedulers clean their own execution nodes; the coordinator
      // itself has no runtime (e.g. the Ray head has no Docker daemon).
      if (components.scheduler.recoverAttempts) await components.scheduler.recoverAttempts(keys, signal);
      else if (components.environment.recoverAttempts) await components.environment.recoverAttempts(keys, signal);
      else if (unconfirmedAttempts.length)
        throw new EvaluatorError("CLEANUP_FAILED", "The environment cannot confirm recovery of previous resources");
      if (components.scheduler.executionLocation !== "remote" && components.benchmark.verificationRuntime) {
        const runtime = components.benchmark.verificationRuntime;
        if (!runtime.recoverAttempts && unconfirmedAttempts.length)
          throw new EvaluatorError("CLEANUP_FAILED", "The verifier cannot confirm recovery of previous resources");
        await runtime.recoverAttempts?.(keys, signal);
      }
      if (jobs.length === 0) {
        // Keep the original attempt's cleanup observation for audit; never solve
        // an already scored task merely to clear its housekeeping diagnosis.
        await components.store.updateRun({ status: "error", finishedAt: new Date().toISOString(), durationMs: elapsed() });
        return await components.store.snapshot();
      }
    }
    const dispatch = await prepareDispatch(components, jobs, source, schedulerSignal, {
      run: config.experiment.run, previous: previous?.preparationRounds ?? [], sensitiveValues,
      batchPreparation, onProgress: taskProgress, savePreparationFailure,
    });
    const { plannedTasks, preparationFailures, readiness, readyJobs, dispatchJobs, planningRecords } = dispatch;
    pipeline = dispatch.pipeline;
    if (dispatch.failed) {
      await components.store.updateRun({ status: "error", finishedAt: new Date().toISOString(), durationMs: elapsed() });
      return await components.store.snapshot();
    }
    const originals = new Map(selected.map(ref => [ref.id, jobs.find(job => job.taskId === ref.id) ?? {
      runId: manifest.runId, taskId: ref.id, ref, attemptId: randomUUID(), configFingerprint: manifest.configFingerprint,
    }]));
    const retry = new TaskQueue(async () => { await control?.stopAccepting(); return true; });
    const streamFailures = new Map<string, number>();
    for (const attempt of previousAttempts) {
      if (attempt.record && isStreamTaskRetryEligible(attempt.record))
        streamFailures.set(attempt.key.taskId, (streamFailures.get(attempt.key.taskId) ?? 0) + 1);
    }
    const canRetryStream = (record: AttemptRecord) => !schedulerSignal.aborted &&
      (streamFailures.get(record.key.taskId) ?? 0) < MAX_STREAM_TASK_RETRIES && isStreamTaskRetryEligible(record);
    taskQueue = retry;
    const cancelQueue = () => retry.close();
    schedulerSignal.addEventListener("abort", cancelQueue, { once: true });
    progress(
      "execute",
      `Starting evaluation of ${jobs.length} tasks; solver=${config.experiment.solver.name}; environment=${config.experiment.environment.name}`,
    );
    const executor: TaskExecutor = async (job, taskSignal) => {
      const preparedTask = plannedTasks.get(job.taskId);
      const admission = readiness.get(job.taskId);
      const preparationFailure = preparationFailures.get(job.taskId);
      const record = await runTask(job, components, source, taskSignal, {
        ...(preparedTask ? { preparedTask } : {}), ...(preparationFailure ? { preparationFailure } : {}),
        preparationConcurrency: preparationConcurrency(
          Number(config.experiment.scheduler.config.concurrency ?? 1), selected.length),
        ...(config.experiment.run.preparation?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: config.experiment.run.preparation.environmentTimeoutSeconds }),
        ...(admission ? { readiness: admission } : {}), timeoutSeconds: config.experiment.run.timeoutSeconds,
        ...(config.experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: config.experiment.run.solveTimeoutSeconds }),
        ...(config.experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: config.experiment.run.verifyTimeoutSeconds }),
        includeTaskAnswer: config.experiment.run.includeTaskAnswer === true, sensitiveValues, onProgress: taskProgress,
      });
      // Abort before returning to a scheduler that may immediately refill a slot.
      if ((!isEvaluationComplete(record) && config.experiment.run.onError !== "continue" && !canRetryStream(record)) || requiresDispatchStop(record) || hasUnconfirmedCleanup(record) ||
        record.errors.some(error => error.code === "ENV_PREPARED_IMAGE_LOST"))
        runController.abort(new Error(`Task ${job.taskId} failed; stopping queued dispatch`));
      return record;
    };
    // Initial readiness, automatic stream recovery and manual reruns share slots.
    if (readyJobs) retry.setInitialSource(readyJobs);
    else {
      for (const job of dispatchJobs) retry.add(job, retryTaskIds ? current.find(record => record.key.taskId === job.taskId)?.key.attemptId : undefined);
      retry.initialComplete();
    }
    try {
      await control?.setAdmission(requests => admitRetryRequests(requests, components.store, originals, retry));
    } catch (error) {
      warnControl(error);
    }
    const recoveryPreparation = new AbortController();
    const recoverySignal = AbortSignal.any([schedulerSignal, recoveryPreparation.signal]);
    const recoveryProducer = (async function* () {
      for await (const job of retry) {
        const expected = retry.expectedFailure(job.attemptId);
        if (expected) {
          const current = components.store.currentTaskResult ? await components.store.currentTaskResult(job.taskId)
            : (await components.store.snapshot()).records.find(record => record.key.taskId === job.taskId);
          if (!current || current.key.attemptId !== expected || !isManualRetryEligible(current)) { retry.discard(job); continue; }
        }
        const prepared = await prepareRetryTask(job, originals.get(job.taskId)?.attemptId, {
          components, source, signal: recoverySignal, run: config.experiment.run, sensitiveValues, onProgress: taskProgress,
        });
        if (prepared) {
          plannedTasks.delete(job.taskId);
          preparationFailures.delete(job.taskId);
          readiness.delete(job.taskId);
          if (prepared.task) plannedTasks.set(job.taskId, prepared.task);
          if (prepared.failure) preparationFailures.set(job.taskId, prepared.failure);
        }
        yield prepared?.failure ? { ...job, preparationFailure: prepared.failure } : job;
      }
    })();
    const dynamicJobs: AsyncIterable<TaskJob> = { [Symbol.asyncIterator]: () => ({
      next: () => recoveryProducer.next(),
      async return() {
        retry.close(); recoveryPreparation.abort(new DOMException("Dispatch closed", "AbortError")); pipeline?.cancel();
        await recoveryProducer.return(undefined);
        return { done: true, value: undefined };
      },
    }) };
    const scheduled = components.scheduler.executeReady(dynamicJobs, executor, schedulerSignal);
    const records = (async function* () { yield* planningRecords; yield* scheduled; })();
    for await (const record of records) {
      retry.complete(record);
      const original = originals.get(record.key.taskId);
      // Enqueue synchronously with complete(), before the queue can close or a
      // manual retry can reserve the same task. The failed attempt is persisted.
      const automaticRetry = canRetryStream(record) && original !== undefined &&
        retry.add({ ...original, attemptId: randomUUID() }, record.key.attemptId);
      if (automaticRetry) streamFailures.set(record.key.taskId, (streamFailures.get(record.key.taskId) ?? 0) + 1);
      else completedTaskIds.add(record.key.taskId);
      for (const error of record.errors)
        taskProgress({
          phase: error.phase,
          taskId: record.key.taskId,
          attemptId: record.key.attemptId,
          error: !(isAgentTimeout(record) && (error.phase === "solve" || error.code === "ARTIFACT_COLLECTION_INCOMPLETE")),
          failure: error,
          message: failureMessage(error),
        });
      if (automaticRetry) {
        taskProgress({ phase: "retry", taskId: record.key.taskId, attemptId: record.key.attemptId, warning: true,
          message: `Model response truncated; restarting the entire task (${streamFailures.get(record.key.taskId)}/${MAX_STREAM_TASK_RETRIES} automatic retries). Previous tools will run again.` });
        continue;
      }
      taskProgress({
        phase: "task",
        taskId: record.key.taskId,
        attemptId: record.key.attemptId,
        message: `Finished: ${attemptStatus(record)}${attemptTimeoutKind(record) ? ` (${attemptTimeoutKind(record)})` : ""}; score=${evaluationScore(record) ?? "none"}; progress ${completedTaskIds.size}/${selected.length}`,
      });
      if ((!isEvaluationComplete(record) && config.experiment.run.onError !== "continue") || requiresDispatchStop(record) || hasUnconfirmedCleanup(record)) {
        taskProgress({
          phase: "task",
          taskId: record.key.taskId,
          attemptId: record.key.attemptId,
          error: true,
          message: requiresDispatchStop(record) || hasUnconfirmedCleanup(record)
            ? `Task requires dispatch to stop (${attemptStatus(record)}). Resolve authentication, storage or resource cleanup errors before continuing with --resume`
            : `Task failed (${attemptStatus(record)}); run.onError=abort stops the evaluation and remaining tasks will not run. Use --resume to continue`,
        });
        runController.abort(
          new Error(
            `Task ${record.key.taskId} ended with status ${attemptStatus(record)}; aborting the run (run.onError=abort)`,
          ),
        );
        break;
      }
    }
    retry.close();
    schedulerSignal.removeEventListener("abort", cancelQueue);
    await pipeline?.completion;
    progress("finalize", "Saving run status");
    const snapshot = await components.store.snapshot();
    const status = signal.aborted
      ? "cancelled"
      : resolveRunStatus(snapshot);
    await components.store.updateRun({ status, finishedAt: new Date().toISOString(), durationMs: elapsed() });
    return await components.store.snapshot();
  } catch (error) {
    pipeline?.cancel(error);
    await pipeline?.completion.catch(() => {});
    try {
      if (pipeline && !signal.aborted) {
        const roundId = pipeline.roundId;
        const snapshot = await components.store.snapshot();
        const pending = new Set(snapshot.pendingTaskIds);
        const round = snapshot.run.preparationRounds?.find(item => item.id === roundId);
        const failedPreparation = new Set(round?.tasks?.filter(item => item.status === "error").map(item => item.taskId));
        for (const job of jobs.filter(item => pending.has(item.taskId) && failedPreparation.has(item.taskId)))
          await savePreparationFailure({ ...job, attemptId: randomUUID() }, error);
      }
      await components.store.updateRun({
        status: signal.aborted ? "cancelled" : "error",
        finishedAt: new Date().toISOString(),
        durationMs: elapsed(),
        failure: classifyError(error, { phase: "prepare", component: "scheduler", secrets: sensitiveValues }),
      });
    } catch (storeError) {
      throw new AggregateError([error, storeError], "Run failed and final status could not be persisted");
    }
    throw error;
  } finally {
    taskQueue?.close();
    await releaseImages?.();
  }
}
