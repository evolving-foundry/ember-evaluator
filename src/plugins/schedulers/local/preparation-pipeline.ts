import { performance } from "node:perf_hooks";
import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext, PreparationPipeline, ReadyTask } from "../../../core/contracts/preparation.js";
import type { Failure, TaskPreparationTiming } from "../../../core/contracts/result.js";
import type { PreparedTask } from "../../../core/contracts/task.js";
import { formatError, redactDiagnostic } from "../../../core/errors/diagnostics.js";
import { createPreparationRound } from "../../../core/preparation/preparation-round.js";
import { classifyError } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { preparationConcurrency } from "../../../core/preparation/preparation-timeout.js";
import { failureDecision } from "../../../core/policies/error-policy.js";

/** Independent preparation workers publish complete task environments in readiness order. */
export function preparePipeline(
  plan: BenchmarkRunPlan,
  context: PreparationContext,
  signal: AbortSignal,
  settings: { concurrency: number; lookahead?: number },
): PreparationPipeline {
  const options = { ...context, ...settings };
  const { round, rounds } = createPreparationRound(plan, context.previous, true, context.settings?.roundTimeoutSeconds);
  const budget = round.budgetSeconds;
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    throw new TypeError("Invalid preparation concurrency");
  const concurrency = preparationConcurrency(options.concurrency, plan.tasks.length);
  const lookahead = options.lookahead ?? Math.max(10, options.concurrency);
  if (!Number.isSafeInteger(lookahead) || lookahead < options.concurrency)
    throw new TypeError("Preparation lookahead must be at least concurrency");
  const now = Date.parse(round.startedAt);
  const timings = round.tasks!;
  round.mode = "pipeline";
  round.deadlineAt = null;
  round.concurrency = concurrency;
  round.lookahead = lookahead;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const cancel = (reason?: unknown) => controller.abort(reason ?? new DOMException("Preparation consumer closed", "AbortError"));
  let remainingMs = budget === null ? null : budget * 1000;
  let budgetStarted = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resumeBudget = () => {
    if (remainingMs === null) return;
    budgetStarted = performance.now();
    round.deadlineAt = new Date(Date.now() + Math.max(0, remainingMs)).toISOString();
    timer = setTimeout(() => cancel(new DOMException("Pipeline environment preparation deadline exceeded", "TimeoutError")), Math.max(0, remainingMs));
    timer.unref();
  };
  const pauseBudget = () => {
    if (timer === undefined) return;
    if (remainingMs !== null) remainingMs -= performance.now() - budgetStarted;
    clearTimeout(timer);
    timer = undefined;
    round.deadlineAt = null;
  };
  const ready: ReadyTask[] = [];
  let changed = Promise.withResolvers<void>();
  const notify = () => { changed.resolve(); changed = Promise.withResolvers<void>(); };
  combined.addEventListener("abort", notify, { once: true });
  let closed = false;
  let failed = false;
  let failure: unknown;
  let streamError = false;
  let consumerClosed = false;
  let pendingPersistence: Promise<void> | undefined;
  let persistenceRequested = false;
  const persist = (): Promise<void> => {
    persistenceRequested = true;
    // Concurrent workers share a flush, but nobody publishes readiness before
    // the snapshot containing their transition has been durably saved.
    pendingPersistence ??= (async () => {
      while (persistenceRequested) {
        persistenceRequested = false;
        await context.store.updateRun({ preparationRounds: structuredClone(rounds) });
      }
    })().catch(cause => {
      throw new EvaluatorError("STORE_WRITE_FAILED", "Cannot save preparation progress", {}, { cause });
    }).finally(() => { pendingPersistence = undefined; });
    return pendingPersistence;
  };
  const exception = () => {
    const structured = classifyError(failure, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED" });
    return new EvaluatorError(structured.code, structured.message, structured.details, { cause: failure });
  };
  const progress = (timing: TaskPreparationTiming, message: string, error = false) =>
      options.onProgress?.({ phase: "prepare", taskId: timing.taskId, message, ...(error ? { error: true } : {}),
        ...(timing.failure ? { failure: timing.failure } : {}) });
  let next = 0;
  let preparing = 0;
  const completion = (async () => {
    let critical = false;
    try {
      await persist();
      combined.throwIfAborted();
      pauseBudget();
      const worker = async () => {
        while (!combined.aborted && next < plan.tasks.length) {
          // Reservations include in-flight preparations so the ready buffer cannot
          // overflow. A worker releases its build slot before waiting for capacity.
          while (!combined.aborted && ready.length + preparing >= lookahead) await changed.promise;
          if (combined.aborted || next >= plan.tasks.length) break;
          const index = next++;
          const task = plan.tasks[index];
          const timing = timings[index];
          if (!task || !timing) throw new Error("Invalid preparation plan index");
          if (preparing++ === 0) resumeBudget();
          const started = performance.now();
          timing.startedAt = new Date().toISOString();
          timing.queueDurationMs = Math.max(0, Date.now() - now);
          timing.status = "preparing";
          await persist();
          progress(timing, `Starting environment preparation; queued for ${(timing.queueDurationMs / 1000).toFixed(1)}s`);
          let prepared: PreparedTask | undefined;
          let preparationFailure: Failure | undefined;
          try {
            prepared = await context.prepareTask(task, combined, { roundId: round.id, timing, concurrency,
              defaultTimeoutSeconds: plan.preparation.defaultTimeoutSeconds, roundSignal: combined,
              ...(context.settings?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: context.settings.environmentTimeoutSeconds }) });
            timing.status = "ready";
          } catch (error) {
            timing.status = combined.aborted ? "cancelled" : "error";
            timing.error = redactDiagnostic(formatError(error), options.sensitiveValues);
            timing.failure = classifyError(error, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED",
              ...(options.sensitiveValues ? { secrets: options.sensitiveValues } : {}) });
            if (!failed) { failed = true; failure = error; }
            if (!signal.aborted && (["abort_run", "stop_dispatch"].includes(failureDecision(timing.failure).action) ||
              options.onError !== "continue")) { streamError = true; cancel(error); notify(); }
            if (!signal.aborted && !streamError) {
              preparationFailure = timing.failure;
              prepared = task;
            }
          }
          timing.finishedAt = new Date().toISOString();
          timing.durationMs = performance.now() - started;
          await persist();
          if (--preparing === 0) pauseBudget();
          if (prepared && !consumerClosed && !signal.aborted && !streamError) {
            ready.push({ task: prepared, timing, ...(preparationFailure ? { failure: preparationFailure } : {}) });
            progress(timing, preparationFailure ? `Environment preparation failed; task is invalid; ${timing.error}` : `Environment ready; preparation took ${(timing.durationMs / 1000).toFixed(1)}s`, !!preparationFailure);
            notify();
          } else {
            progress(timing, `Environment preparation ${timing.status}; elapsed ${(timing.durationMs / 1000).toFixed(1)}s; ${timing.error ?? "cancelled"}`, true);
          }
          notify();
        }
      };
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(options.concurrency, plan.tasks.length) }, async () => {
        try { await worker(); } catch (error) {
          failed = true; failure = error; streamError = true; cancel(error); notify(); throw error;
        }
      }));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") { critical = true; throw rejected.reason; }
      if (combined.aborted && !failed) { failed = true; failure = combined.reason; }
    } catch (error) {
      critical = true;
      failed = true;
      failure = error;
      cancel(error);
    } finally {
      clearTimeout(timer);
      cancel(new DOMException("Preparation round finished", "AbortError"));
      combined.removeEventListener("abort", notify);
      for (const timing of timings) {
        if (timing.status === "queued") {
          timing.status = "cancelled";
          timing.finishedAt = new Date().toISOString();
          timing.error = "Preparation stopped before this task started";
        }
      }
      if (signal.aborted) round.status = "cancelled";
      else if (failed) round.status = "error";
      else round.status = consumerClosed ? "cancelled" : "ready";
      round.finishedAt = new Date().toISOString();
      if (failed) {
        round.error = redactDiagnostic(formatError(failure), options.sensitiveValues);
        round.failure = classifyError(failure, { phase: "prepare", component: "environment", fallbackCode: "ENV_PREPARATION_FAILED",
          ...(options.sensitiveValues ? { secrets: options.sensitiveValues } : {}) });
      }
      try { await persist(); } catch (error) {
        failure = error;
        failed = true;
        critical = true;
      }
      streamError = streamError || failed && (critical || (!consumerClosed && !signal.aborted && options.onError !== "continue"));
      closed = true;
      notify();
    }
    if (streamError) throw exception();
  })();
  // The scheduler sees the same failure through next(); keep the producer handled
  // even while the consumer is waiting for already-started attempts to settle.
  void completion.catch(() => {});
  const iterator: AsyncIterator<ReadyTask> = {
    async next() {
      for (;;) {
        if (consumerClosed) return { done: true, value: undefined };
        if (streamError) throw exception();
        const value = ready.shift();
        if (value) { notify(); return { done: false, value }; }
        if (closed) return { done: true, value: undefined };
        await changed.promise;
      }
    },
    async return() {
      if (!closed) { consumerClosed = true; cancel(); }
      ready.length = 0;
      notify();
      await completion.catch(() => {});
      return { done: true, value: undefined };
    },
  };
  return { tasks: { [Symbol.asyncIterator]: () => iterator }, completion, roundId: round.id, cancel };
}
