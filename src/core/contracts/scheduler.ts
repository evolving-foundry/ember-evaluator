import type { AttemptKey, AttemptRecord, Failure, RunManifest } from "./result.js";
import type { JsonValue, TaskRef } from "./task.js";
import type { RunStore } from "./run-store.js";
import type { ProgressListener } from "../progress/progress.js";
import type { BenchmarkRunPlan } from "./benchmark.js";
import type { PreparationContext, ScheduledPreparation } from "./preparation.js";

export type SchedulerContext = {
  run: RunManifest;
  safeConfig: JsonValue;
  store: RunStore /** Progress-channel logging for scheduling diagnostics; shown to the user by the CLI. */;
  log?(message: string): void;
  onProgress?: ProgressListener;
};

/** Locked metadata for preparing dependencies, independent of result persistence. */
export type SchedulerPreparationContext = {
  session: Pick<RunManifest, "runId" | "source" | "configFingerprint" | "pluginVersions" | "solverProvenance">;
  safeConfig: JsonValue;
  log?(message: string): void;
  onProgress?: ProgressListener;
};

export type TaskJob = {
  runId: string;
  taskId: string;
  ref: TaskRef;
  attemptId: string;
  configFingerprint: string;
  preparationFailure?: Failure;
};

export type TaskExecutor = (job: TaskJob, signal: AbortSignal) => Promise<AttemptRecord>;

export interface TaskScheduler {
  cleanupImages?(request: import("./image-cleanup.js").ImageCleanupRequest, environment: import("./config.js").Selection, pluginVersions: Record<string, string>, signal: AbortSignal): Promise<import("./image-cleanup.js").ImageCleanupNode[]>;
  readonly executionLocation?: "remote";
  validateCapacity?(taskCount: number): void;
  /** Arrange planned preparation, including its barrier or readiness queue, before execution admission. */
  prepareTasks?(jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation>;
  /** Optional coordinator setup; this context must never be serialized wholesale. */
  setup?(context: SchedulerContext, signal: AbortSignal): Promise<void>;
  /** Prepare remote transport without admitting an evaluation run or result uploads. */
  setupPreparation?(context: SchedulerPreparationContext, signal: AbortSignal): Promise<void>;
  /**
   * Optional recovery of environments left behind by interrupted attempts. When
   * present it replaces environment.recoverAttempts: distributed schedulers clean
   * up on their execution nodes, where the coordinator itself has no runtime.
   */
  recoverAttempts?(attempts: AttemptKey[], signal: AbortSignal): Promise<void>;
  /** Dispatch fully prepared jobs as they arrive; source.return() must cancel and drain preparation. */
  executeReady(jobs: AsyncIterable<TaskJob>, executor: TaskExecutor, signal: AbortSignal): AsyncIterable<AttemptRecord>;
}
