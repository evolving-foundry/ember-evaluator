import type { AttemptRecord, Failure } from "../contracts/result.js";
import type { TaskJob } from "../contracts/scheduler.js";
import type { PreparedTask } from "../contracts/task.js";

export type DescribedTask = { state: "described"; task: PreparedTask };

/** Dependencies are ready on the execution node. The attempt still opens its sessions. */
export type ReadyDependencies = {
  state: "ready";
  task: PreparedTask;
  readiness?: NonNullable<AttemptRecord["readiness"]>;
};

export type TaskPreparation =
  | { state: "on-demand" }
  | DescribedTask
  | ReadyDependencies
  | { state: "failed"; failure: Failure };

export type DispatchEntry = { job: TaskJob; preparation: TaskPreparation };

export function onDemand(job: TaskJob): DispatchEntry {
  return { job, preparation: { state: "on-demand" } };
}
