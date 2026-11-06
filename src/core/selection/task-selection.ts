import type { ExecutionConfig } from "../contracts/config.js";
import type { Benchmark } from "../contracts/benchmark.js";
import type { SourceLock, TaskRef } from "../contracts/task.js";
import { shuffleTasks } from "./task-sampling.js";
import { EvaluatorError } from "../errors/evaluator-error.js";
import type { ActivityListener } from "../contracts/activity.js";

type RunSelection = Pick<ExecutionConfig["experiment"]["run"], "maxTasks" | "offset" | "taskIds" | "sampling">;

export type SelectedTasks = { all: TaskRef[]; selected: TaskRef[] };

/** Enumerate and select the same ordered task set for execution and dry-run. */
export async function enumerateSelectedTasks(
  benchmark: Benchmark,
  source: SourceLock,
  run: RunSelection,
  signal: AbortSignal,
  activity?: ActivityListener,
): Promise<SelectedTasks> {
  const all: TaskRef[] = [];
  const ids = new Set<string>();
  let last = -Infinity;
  for await (const ref of benchmark.enumerate(source, signal, activity)) {
    signal.throwIfAborted();
    if (!ref.id || ids.has(ref.id)) throw new EvaluatorError("TASK_DATA_INVALID", `Invalid or duplicate source task ID: ${ref.id}`);
    ids.add(ref.id);
    all.push(ref);
    if (performance.now() - last >= 200) {
      activity?.({ lines: [`Enumerated ${all.length} tasks`] });
      last = performance.now();
    }
  }

  const requested = run.taskIds;
  if (requested !== null) {
    const unknown = requested.filter(id => !ids.has(id));
    if (unknown.length) throw new EvaluatorError("CONFIG_INVALID", `Unknown task IDs: ${unknown.join(", ")}`);
  }
  const wanted = requested === null ? null : new Set(requested);
  let selected = all.filter(ref => wanted === null || wanted.has(ref.id));
  if (run.sampling?.strategy === "random") selected = shuffleTasks(selected, run.sampling.seed);
  selected = selected.slice(run.offset ?? 0);
  if (run.maxTasks !== null) selected = selected.slice(0, run.maxTasks);
  if (!selected.length) throw new EvaluatorError("CONFIG_INVALID", "Empty task selection");
  activity?.({ lines: [`Enumeration completed: ${all.length} tasks available, ${selected.length} selected`] });
  return { all, selected };
}
