import type { Benchmark, BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { SourceLock, TaskRef } from "../../../core/contracts/task.js";
import { classifyError, declaredErrorCode } from "../../../core/errors/classify.js";
import { ERROR_CODES } from "../../../core/errors/registry.js";
import type { ActivityListener } from "../../../core/contracts/activity.js";
import { preparationTimeoutMs } from "../../../core/preparation/preparation-timeout.js";

/** Versioned benchmark policy, deliberately independent of run timeout overrides. */
export async function planBenchmarkRun(
  benchmark: Pick<Benchmark, "prepare">,
  refs: TaskRef[],
  source: SourceLock,
  signal: AbortSignal,
  policy: BenchmarkRunPlan["policy"],
  fallbackSeconds: number,
  activity?: ActivityListener,
): Promise<BenchmarkRunPlan> {
  preparationTimeoutMs(fallbackSeconds);
  const tasks: BenchmarkRunPlan["tasks"] = [];
  const preparationFailures: NonNullable<BenchmarkRunPlan["preparationFailures"]> = [];
  for (const ref of refs) {
    signal.throwIfAborted();
    const number = tasks.length + preparationFailures.length + 1;
    activity?.({ message: `Planning task ${number}/${refs.length} ${ref.id}`, lines: [`Reading task metadata ${number}/${refs.length}`] });
    const report = () => activity?.({ lines: [`Checked ${number}/${refs.length} tasks; ${preparationFailures.length} preparation failures`] });
    let task;
    try { task = await benchmark.prepare(ref, source, signal, activity); }
    catch (error) {
      signal.throwIfAborted();
      const declared = declaredErrorCode(error);
      // An explicit run failure must not become task-local, even when its cause
      // happens to contain a recoverable transport diagnostic.
      if (declared && ERROR_CODES[declared].scope === "run") throw error;
      const network = classifyError(error, { phase: "prepare", component: "source" });
      if (network.code === "NETWORK_FAILURE") { preparationFailures.push({ taskId: ref.id, failure: network }); report(); continue; }
      // Only explicitly task-local errors are recoverable here. Source identity,
      // I/O and configuration failures still invalidate the entire plan.
      if (declared !== "TASK_DATA_INVALID" && declared !== "BENCHMARK_UNSUPPORTED") throw error;
      const failure = classifyError(error, { phase: "prepare", component: "benchmark" });
      if (failure.code !== "TASK_DATA_INVALID" && failure.code !== "BENCHMARK_UNSUPPORTED") throw error;
      preparationFailures.push({ taskId: ref.id, failure });
      report();
      continue;
    }
    if (task.input.id !== ref.id) throw new TypeError(`Planned task identity differs: ${ref.id}`);
    tasks.push(task);
    report();
  }
  activity?.({ lines: [`Planning completed ${refs.length}/${refs.length}; ${tasks.length} succeeded, ${preparationFailures.length} failed`] });
  for (const task of tasks)
    for (const limit of Object.values(task.preparationTimeoutSeconds ?? {})) preparationTimeoutMs(limit);
  return {
    tasks,
    ...(preparationFailures.length ? { preparationFailures } : {}),
    preparation: { defaultTimeoutSeconds: fallbackSeconds },
    policy,
  };
}
