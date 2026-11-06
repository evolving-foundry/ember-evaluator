import { randomUUID } from "node:crypto";
import type { BenchmarkRunPlan } from "../contracts/benchmark.js";
import type { PreparationContext } from "../contracts/preparation.js";
import type { PreparationRound } from "../contracts/result.js";
import { formatError, redactDiagnostic } from "../errors/diagnostics.js";
import { classifyError } from "../errors/classify.js";
import { preparationTimeoutMs } from "./preparation-timeout.js";

/** Shared record format and budget validation; no task scheduling occurs here. */
export function createPreparationRound(plan: BenchmarkRunPlan, previous: PreparationRound[], taskTimings = true, roundTimeoutSeconds?: number) {
  preparationTimeoutMs(plan.preparation.defaultTimeoutSeconds);
  const budget = roundTimeoutSeconds ?? null;
  const budgetMs = budget === null ? null : preparationTimeoutMs(budget);
  const started = Date.now();
  const round: PreparationRound = {
    id: randomUUID(), taskIds: plan.tasks.map(task => task.input.id), policy: plan.policy, timeoutPolicy: "task-concurrency-v1",
    budgetSeconds: budget, startedAt: new Date(started).toISOString(),
    deadlineAt: budgetMs === null ? null : new Date(started + budgetMs).toISOString(), finishedAt: null, status: "preparing",
    ...(taskTimings ? { tasks: plan.tasks.map(task => ({ taskId: task.input.id, status: "queued" as const,
      queuedAt: new Date(started).toISOString(), startedAt: null, finishedAt: null, queueDurationMs: null, durationMs: null, phaseDurationMs: {} })) } : {}),
  };
  const rounds = [...previous.map(item => item.status === "preparing"
    ? { ...item, status: "error" as const, finishedAt: round.startedAt, error: "Preparation interrupted before a terminal receipt" }
    : item), round];
  return { round, rounds };
}

/** Persist a round, optionally bounded by an explicitly configured batch deadline. */
export async function runPreparationRound(
  plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal,
  prepare: (round: PreparationRound, signal: AbortSignal) => Promise<BenchmarkRunPlan["tasks"]>,
  taskTimings = true,
): Promise<BenchmarkRunPlan["tasks"]> {
  const { round, rounds } = createPreparationRound(plan, context.previous, taskTimings, context.settings?.roundTimeoutSeconds);
  const controller = new AbortController();
  const timer = round.budgetSeconds === null ? undefined : setTimeout(() => controller.abort(new DOMException("Batch environment preparation deadline exceeded", "TimeoutError")), preparationTimeoutMs(round.budgetSeconds));
  timer?.unref();
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    await context.store.updateRun({ preparationRounds: rounds });
    combined.throwIfAborted();
    const tasks = await prepare(round, combined);
    combined.throwIfAborted();
    round.status = (plan.preparationFailures?.length ?? 0) ? "error" : "ready";
    if (round.status === "error") round.error = "Some tasks failed preparation; see per-task failure evidence";
    round.finishedAt = new Date().toISOString();
    await context.store.updateRun({ preparationRounds: rounds });
    return tasks;
  } catch (error) {
    controller.abort(error);
    round.status = signal.aborted ? "cancelled" : "error";
    round.error = redactDiagnostic(formatError(error), context.sensitiveValues);
    round.failure = classifyError(error, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED", secrets: context.sensitiveValues });
    round.finishedAt = new Date().toISOString();
    for (const timing of round.tasks ?? []) {
      if (timing.status !== "queued" && timing.status !== "preparing") continue;
      timing.status = "cancelled";
      timing.finishedAt = round.finishedAt;
      timing.error = "Preparation stopped before readiness";
    }
    await context.store.updateRun({ preparationRounds: rounds });
    throw error;
  } finally { clearTimeout(timer); controller.abort(new DOMException("Preparation round finished", "AbortError")); }
}
