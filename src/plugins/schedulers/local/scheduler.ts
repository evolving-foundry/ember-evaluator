import type { TaskExecutor, TaskJob, TaskScheduler } from "../../../core/contracts/scheduler.js";
import type { AttemptRecord } from "../../../core/contracts/result.js";
import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext, ScheduledPreparation } from "../../../core/contracts/preparation.js";
import { prepareBatch } from "./preparation.js";
import { preparePipeline } from "./preparation-pipeline.js";

type Settled = { ok: true; record: AttemptRecord } | { ok: false; error: unknown };

export class LocalScheduler implements TaskScheduler {
  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new TypeError("concurrency must be a positive integer");
  }

  async prepareTasks(_jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation> {
    const settings = { mode: "pipeline" as const, concurrency: this.concurrency, ...context.settings };
    if (settings.mode === "pipeline") return { pipeline: preparePipeline(plan, context, signal, settings) };
    if (settings.lookahead !== undefined)
      throw new TypeError("Batch preparation does not accept lookahead");
    return { tasks: await prepareBatch(plan, { ...context, settings }, signal) };
  }

  async *executeReady(jobs: AsyncIterable<TaskJob>, executor: TaskExecutor, signal: AbortSignal): AsyncIterable<AttemptRecord> {
    const iterator = jobs[Symbol.asyncIterator]();
    const controller = new AbortController();
    const active = new Map<number, Promise<void>>();
    const completed: Settled[] = [];
    let available = Promise.withResolvers<void>();
    const notify = () => { available.resolve(); available = Promise.withResolvers<void>(); };
    let closing: Promise<unknown> | undefined;
    const closeSource = () => closing ??= Promise.resolve().then(() => iterator.return?.());
    const cancel = () => {
      controller.abort(signal.reason);
      void closeSource().catch(() => {});
      notify();
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    let finished = false;
    let next = 0;
    const producer = (async () => {
      try {
        while (!controller.signal.aborted) {
          while (!controller.signal.aborted && active.size >= this.concurrency) await available.promise;
          if (controller.signal.aborted) break;
          const item = await iterator.next();
          if (item.done || controller.signal.aborted) break;
          const index = next++;
          const tracked = (async () => executor(item.value, controller.signal))().then(
            record => { active.delete(index); completed.push({ ok: true, record }); notify(); },
            error => {
              active.delete(index); completed.push({ ok: false, error });
              controller.abort(error); void closeSource().catch(() => {}); notify();
            },
          );
          active.set(index, tracked);
        }
      } catch (error) {
        completed.push({ ok: false, error });
        controller.abort(error);
        void closeSource().catch(() => {});
      } finally {
        finished = true;
        notify();
      }
    })();
    try {
      while (!finished || completed.length || active.size) {
        const result = completed.shift();
        if (!result) { await available.promise; continue; }
        if (!result.ok) throw result.error;
        yield result.record;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      controller.abort();
      notify();
      // return() must interrupt an outstanding next() in readiness sources.
      const outcomes = await Promise.allSettled([closeSource(), producer, ...active.values()]);
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }

}
