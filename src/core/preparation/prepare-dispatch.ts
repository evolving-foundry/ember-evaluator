import type { RunComponents } from "../contracts/components.js";
import type { TaskJob } from "../contracts/scheduler.js";
import type { SourceLock } from "../contracts/task.js";
import type { AttemptRecord, PreparationRound } from "../contracts/result.js";
import type { EffectiveConfig } from "../contracts/config.js";
import type { ProgressListener } from "../progress/progress.js";
import { createTaskPreparer } from "./materialize-task.js";
import type { PreparationPipeline, ScheduledPreparation } from "../contracts/preparation.js";
import { classifyError } from "../errors/classify.js";
import { progressOperation } from "../progress/progress-operation.js";
import { onDemand, type DispatchEntry } from "./task-preparation.js";

type PreparationDispatch =
  | { failed: true }
  | { failed: false; planningRecords: AttemptRecord[]; entries: DispatchEntry[]; pipeline?: never }
  | { failed: false; planningRecords: AttemptRecord[]; entries: AsyncIterable<DispatchEntry>; pipeline: PreparationPipeline };

function pipelineEntries(pipeline: PreparationPipeline, jobs: TaskJob[]): AsyncIterable<DispatchEntry> {
  const producer = pipeline.tasks[Symbol.asyncIterator]();
  const pending = new Map(jobs.map(job => [job.taskId, job]));
  // Delegate return() directly so cancellation is not queued behind a pending next().
  return { [Symbol.asyncIterator]: () => ({
    async next() {
      const item = await producer.next();
      if (item.done) return { done: true, value: undefined };
      const { task, failure, timing } = item.value;
      const job = pending.get(task.input.id);
      const readyAt = timing.finishedAt;
      if (!job || !readyAt) throw new Error("Ready task differs from locked task plan");
      pending.delete(job.taskId);
      const preparation = failure ? { state: "failed" as const, failure } : {
        state: "ready" as const, task,
        readiness: { roundId: pipeline.roundId, readyAt, queueDurationMs: Math.max(0, Date.now() - Date.parse(readyAt)) },
      };
      return { done: false, value: { job, preparation } };
    },
    async return() { await producer.return?.(); return { done: true, value: undefined }; },
  }) };
}

/** Prepares selected tasks and preserves per-task failures for coordinator recovery. */
export async function prepareDispatch(
  components: RunComponents, jobs: TaskJob[], source: SourceLock, signal: AbortSignal,
  options: { run: EffectiveConfig["run"]; previous: PreparationRound[]; sensitiveValues: readonly string[];
    onProgress: ProgressListener; savePreparationFailure(job: TaskJob, error: unknown): Promise<AttemptRecord> },
): Promise<PreparationDispatch> {
  const planRun = components.benchmark.planRun?.bind(components.benchmark);
  if (!planRun) return { failed: false, planningRecords: [], entries: jobs.map(onDemand) };
  const { run, sensitiveValues, savePreparationFailure, onProgress } = options;
  const planningRecords: AttemptRecord[] = [];
  const plan = await progressOperation(onProgress, {
    phase: "prepare", message: "Planning task environments; the scheduler will arrange preparation and dispatch",
  }, signal, activity => planRun(jobs.map(job => job.ref), source, signal, activity));
  const byId = new Map(jobs.map(job => [job.taskId, job]));
  const initialFailures = plan.preparationFailures ?? [];
  const plannedIds = [...plan.tasks.map(task => task.input.id), ...initialFailures.map(item => item.taskId)];
  const failedIds = new Set(initialFailures.map(item => item.taskId));
  const dispatchJobs = jobs.filter(job => !failedIds.has(job.taskId));
  if (plannedIds.length !== jobs.length || new Set(plannedIds).size !== jobs.length || plannedIds.some(id => !byId.has(id)) ||
      plan.tasks.some((task, index) => task.input.id !== dispatchJobs[index]?.taskId))
    throw new TypeError("Benchmark run plan differs from locked task selection");
  for (const item of initialFailures) {
    const job = byId.get(item.taskId);
    if (!job) throw new TypeError("Unknown failed task in benchmark plan");
    planningRecords.push(await savePreparationFailure(job, item.failure));
    if (run.onError !== "continue") return { failed: true };
  }

  let scheduled: ScheduledPreparation;
  try {
    if (!components.scheduler.prepareTasks) throw new Error("Scheduler must implement prepareTasks() for benchmark.planRun()");
    scheduled = await components.scheduler.prepareTasks(dispatchJobs, plan, {
      previous: options.previous, ...(run.preparation ? { settings: run.preparation } : {}),
      ...(run.onError ? { onError: run.onError } : {}), sensitiveValues, onProgress, store: components.store,
      prepareTask: createTaskPreparer(components, { sensitiveValues, onProgress }),
    }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const failure = classifyError(error, { phase: "prepare", component: "environment", secrets: sensitiveValues });
    // The round records a barrier timeout; only started attempts that were not ready get a task failure.
    const round = failure.code === "ENV_PREPARATION_TIMEOUT"
      ? (await components.store.snapshot()).run.preparationRounds?.at(-1) : undefined;
    const taskFailures = round?.tasks ? new Map(round.tasks.filter(task => task.startedAt !== null && task.status !== "ready")
      .map(task => [task.taskId, task.failure ?? failure])) : undefined;
    for (const job of dispatchJobs) {
      if (taskFailures && !taskFailures.has(job.taskId)) continue;
      await savePreparationFailure(job, taskFailures?.get(job.taskId) ?? failure);
    }
    return { failed: true };
  }
  if (scheduled.pipeline) return {
    planningRecords, entries: pipelineEntries(scheduled.pipeline, dispatchJobs), pipeline: scheduled.pipeline, failed: false,
  };

  for (const item of plan.preparationFailures ?? []) {
    if (failedIds.has(item.taskId)) continue;
    const job = byId.get(item.taskId);
    if (!job) throw new TypeError("Unknown failed task in scheduled preparation");
    planningRecords.push(await savePreparationFailure(job, item.failure));
    failedIds.add(item.taskId);
  }
  const prepared = new Map(scheduled.tasks.map(task => [task.input.id, task]));
  const readyJobs = dispatchJobs.filter(job => !failedIds.has(job.taskId));
  if (prepared.size !== scheduled.tasks.length || prepared.size !== readyJobs.length)
    throw new TypeError("Batch preparation differs from locked task plan");
  // Ray returns descriptions to the coordinator. The ready receipts stay on the workers.
  const state = components.scheduler.executionLocation === "remote" ? "described" : "ready";
  const entries = readyJobs.map((job): DispatchEntry => {
    const task = prepared.get(job.taskId);
    if (!task) throw new TypeError("Batch preparation differs from locked task plan");
    return { job, preparation: { state, task } };
  });
  onProgress({ phase: "prepare", message: "Batch environment preparation completed; starting rolling dispatch" });
  return { planningRecords, entries, failed: false };
}
