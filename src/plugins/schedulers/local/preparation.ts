import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext } from "../../../core/contracts/preparation.js";
import { runPreparationRound } from "../../../core/preparation/preparation-round.js";
import { classifyError } from "../../../core/errors/classify.js";
import { runPreparationQueue } from "../shared/preparation-queue.js";
import type { PreparedTask } from "../../../core/contracts/task.js";
import { preparationConcurrency } from "../../../core/preparation/preparation-timeout.js";
import { failureDecision } from "../../../core/policies/error-policy.js";

/** Open the batch barrier only after all bounded preparation workers have settled. */
export async function prepareBatch(plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<PreparedTask[]> {
  return runPreparationRound(plan, context, signal, async (round, preparationSignal) => {
    const concurrency = preparationConcurrency(context.settings?.concurrency ?? 1, plan.tasks.length);
    if (concurrency !== 1) { round.mode = "batch"; round.concurrency = concurrency; }
    const tasks: (PreparedTask | undefined)[] = new Array(plan.tasks.length);
    await runPreparationQueue(plan.tasks, concurrency, preparationSignal, async (task, index, taskSignal) => {
      const timing = round.tasks![index]!;
      timing.status = "preparing";
      timing.startedAt = new Date().toISOString();
      timing.queueDurationMs = Date.now() - Date.parse(timing.queuedAt);
      try {
        tasks[index] = await context.prepareTask(task, taskSignal, { roundId: round.id, timing, concurrency,
          defaultTimeoutSeconds: plan.preparation.defaultTimeoutSeconds, roundSignal: preparationSignal,
          ...(context.settings?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: context.settings.environmentTimeoutSeconds }) });
        timing.status = "ready";
      } catch (error) {
        const failure = classifyError(error, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED", secrets: context.sensitiveValues });
        timing.status = taskSignal.aborted ? "cancelled" : "error";
        timing.error = failure.message;
        timing.failure = failure;
        if (taskSignal.aborted) throw error;
        (plan.preparationFailures ??= []).push({ taskId: task.input.id, failure });
        if (["abort_run", "stop_dispatch"].includes(failureDecision(failure).action) ||
          (context.onError !== "continue")) throw error;
      } finally {
        timing.finishedAt = new Date().toISOString();
        timing.durationMs = Date.now() - Date.parse(timing.startedAt);
      }
    });
    return tasks.filter((task): task is PreparedTask => task !== undefined);
  });
}
