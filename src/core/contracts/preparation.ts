import type { BenchmarkRunPlan } from "./benchmark.js";
import type { Failure, PreparationRound, TaskPreparationTiming } from "./result.js";
import type { PreparedTask } from "./task.js";
import type { RunStore } from "./run-store.js";
import type { ProgressListener } from "../progress/progress.js";
import type { EffectiveConfig } from "./config.js";

export type TaskPreparationContext = {
  roundId: string;
  attemptId?: string;
  timing?: TaskPreparationTiming;
  concurrency: number;
  defaultTimeoutSeconds: number;
  environmentTimeoutSeconds?: number;
  /** Owns shared runtime description work independently of any one waiting task. */
  roundSignal: AbortSignal;
};

export type TaskPreparer = (task: PreparedTask, signal: AbortSignal, context: TaskPreparationContext) => Promise<PreparedTask>;

export type ReadyTask = { task: PreparedTask; timing: TaskPreparationTiming; failure?: Failure };

export type PreparationPipeline = {
  tasks: AsyncIterable<ReadyTask>;
  completion: Promise<void>;
  roundId: string;
  cancel(reason?: unknown): void;
};

export type PreparationContext = {
  previous: PreparationRound[];
  settings?: NonNullable<EffectiveConfig["run"]["preparation"]>;
  onError?: "abort" | "continue";
  sensitiveValues: readonly string[];
  onProgress?: ProgressListener;
  store: Pick<RunStore, "updateRun">;
  prepareTask: TaskPreparer;
};

export type TaskPlacement = { taskId: string; nodeId: string };

export type ScheduledPreparation = (
  | { tasks: BenchmarkRunPlan["tasks"]; pipeline?: never }
  | { pipeline: PreparationPipeline; tasks?: never }
) & { placements?: TaskPlacement[] };
