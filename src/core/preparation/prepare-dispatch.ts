import type { RunComponents } from "../contracts/components.js";
import type { TaskJob } from "../contracts/scheduler.js";
import type { PreparedTask, SourceLock } from "../contracts/task.js";
import type { AttemptRecord, Failure, PreparationRound } from "../contracts/result.js";
import type { EffectiveConfig } from "../contracts/config.js";
import type { ProgressListener } from "../progress/progress.js";
import { createTaskPreparer } from "./materialize-task.js";
import type { PreparationPipeline, ScheduledPreparation } from "../contracts/preparation.js";
import { classifyError } from "../errors/classify.js";
import { progressOperation } from "../progress/progress-operation.js";

/** Prepares selected tasks and preserves per-task failures for coordinator recovery. */
export async function prepareDispatch(
  components: RunComponents, jobs: TaskJob[], source: SourceLock, schedulerSignal: AbortSignal,
  options: { run: EffectiveConfig["run"]; previous: PreparationRound[]; sensitiveValues: readonly string[];
    batchPreparation: boolean; onProgress: ProgressListener;
    savePreparationFailure(job: TaskJob, error: unknown): Promise<AttemptRecord> },
) {
  const { sensitiveValues, savePreparationFailure, onProgress: taskProgress, batchPreparation } = options;
  const preparation = options.run.preparation;
  const signal = schedulerSignal;
  const progress = (phase: string, message: string) => taskProgress({ phase, message });
  let pipeline: PreparationPipeline | undefined;
  const plannedTasks = new Map<string, PreparedTask>();
  const preparationFailures = new Map<string, Failure>();
  const readiness = new Map<string, NonNullable<AttemptRecord["readiness"]>>();
  const planningRecords: AttemptRecord[] = [];
  let dispatchJobs = jobs;
  let readyJobs: AsyncIterable<TaskJob> | undefined;
  if (batchPreparation && components.benchmark.planRun) {
    const plan = await progressOperation(taskProgress, { phase: "prepare", message: "Planning task environments; the scheduler will arrange preparation and dispatch" }, schedulerSignal,
      activity => components.benchmark.planRun!(jobs.map(job => job.ref), source, schedulerSignal, activity));
    const plannedIds = [...plan.tasks.map(task => task.input.id), ...(plan.preparationFailures ?? []).map(item => item.taskId)];
    const selectedIds = new Set(jobs.map(job => job.taskId));
    const rejectedIds = new Set((plan.preparationFailures ?? []).map(item => item.taskId));
    const preparedJobs = jobs.filter(job => !rejectedIds.has(job.taskId));
    if (plannedIds.length !== jobs.length || new Set(plannedIds).size !== jobs.length || plannedIds.some(id => !selectedIds.has(id)) ||
        plan.tasks.some((task, index) => task.input.id !== preparedJobs[index]?.taskId))
      throw new TypeError("Benchmark run plan differs from locked task selection");
    const failedIds = new Set<string>();
    for (const item of plan.preparationFailures ?? []) {
      const job = jobs.find(job => job.taskId === item.taskId);
      if (!job) throw new TypeError("Unknown failed task in benchmark plan");
      failedIds.add(item.taskId);
      planningRecords.push(await savePreparationFailure(job, item.failure));
      if (options.run.onError !== "continue") break;
    }
    dispatchJobs = jobs.filter(job => !failedIds.has(job.taskId));
    if (planningRecords.length > 0 && options.run.onError !== "continue") {
      return { plannedTasks, preparationFailures, readiness, planningRecords, dispatchJobs, readyJobs, pipeline, failed: true };
    }
    let scheduled: ScheduledPreparation;
    try {
      if (!components.scheduler.prepareTasks) throw new Error("Scheduler must implement prepareTasks() for benchmark.planRun()");
      scheduled = await components.scheduler.prepareTasks(dispatchJobs, plan, {
        previous: options.previous, ...(preparation ? { settings: preparation } : {}),
        ...(options.run.onError ? { onError: options.run.onError } : {}), sensitiveValues,
        onProgress: taskProgress, store: components.store,
        prepareTask: createTaskPreparer(components, { sensitiveValues, onProgress: taskProgress }),
      }, schedulerSignal);
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = classifyError(error, { phase: "prepare", component: "environment", secrets: sensitiveValues });
      // Do not attribute an environment timeout to work that never started or
      // was already ready. The round retains the barrier failure.
      const round = failure.code === "ENV_PREPARATION_TIMEOUT"
        ? (await components.store.snapshot()).run.preparationRounds?.at(-1) : undefined;
      const taskFailures = round?.tasks ? new Map(round.tasks.filter(task => task.startedAt !== null && task.status !== "ready")
        .map(task => [task.taskId, task.failure ?? failure])) : undefined;
      for (const job of dispatchJobs) {
        if (taskFailures && !taskFailures.has(job.taskId)) continue;
        const record = await savePreparationFailure(job, taskFailures?.get(job.taskId) ?? failure);
        planningRecords.push(record); failedIds.add(job.taskId);
      }
      return { plannedTasks, preparationFailures, readiness, planningRecords, dispatchJobs, readyJobs, pipeline, failed: true };
    }
    if (scheduled.pipeline) {
      pipeline = scheduled.pipeline;
      const producer = pipeline.tasks[Symbol.asyncIterator]();
      const roundId = pipeline.roundId;
      const byId = new Map(dispatchJobs.map(job => [job.taskId, job]));
      // Delegate return() directly: an async-generator wrapper could queue it
      // behind a pending next() and leave preparation blocked on cancellation.
      readyJobs = { [Symbol.asyncIterator]: () => ({
        async next() {
          const item = await producer.next();
          if (item.done) return { done: true, value: undefined };
          const job = byId.get(item.value.task.input.id);
          const readyAt = item.value.timing.finishedAt;
          if (!job || !readyAt) throw new Error("Ready task differs from locked task plan");
          plannedTasks.set(job.taskId, item.value.task);
          if (item.value.failure) preparationFailures.set(job.taskId, item.value.failure);
          if (!item.value.failure)
            readiness.set(job.taskId, { roundId, readyAt, queueDurationMs: Math.max(0, Date.now() - Date.parse(readyAt)) });
          return { done: false, value: job };
        },
        async return() { await producer.return?.(); return { done: true, value: undefined }; },
      }) };
    } else {
      const tasks = scheduled.tasks;
      for (const item of plan.preparationFailures ?? []) {
        if (failedIds.has(item.taskId)) continue;
        const job = jobs.find(job => job.taskId === item.taskId)!;
        planningRecords.push(await savePreparationFailure(job, item.failure)); failedIds.add(item.taskId);
      }
      dispatchJobs = jobs.filter(job => !failedIds.has(job.taskId));
      for (const task of tasks) plannedTasks.set(task.input.id, task);
      progress("prepare", "Batch environment preparation completed; starting rolling dispatch");
    }
  }
  return { plannedTasks, preparationFailures, readiness, planningRecords, dispatchJobs, readyJobs, pipeline, failed: false };
}
