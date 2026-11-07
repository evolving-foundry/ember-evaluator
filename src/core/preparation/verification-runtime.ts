import type { Benchmark } from "../contracts/benchmark.js";
import type { PreparedTask } from "../contracts/task.js";
import type { ActivityListener } from "../contracts/activity.js";
import { assertJsonValue } from "../validation/input.js";

export async function materializeVerificationRuntime(task: PreparedTask, benchmark: Benchmark,
  signal: AbortSignal, activity?: ActivityListener): Promise<PreparedTask> {
  if (!benchmark.verificationRuntime) return task;
  signal.throwIfAborted();
  activity?.({ lines: ["Preparing verifier runtime"] });
  const receipt = await benchmark.verificationRuntime.materialize(task, signal,
    activity ? event => activity({ activity: event.activity ?? true }) : undefined);
  signal.throwIfAborted();
  assertJsonValue(receipt, "verification runtime receipt");
  return { ...task, verificationRuntime: receipt };
}
