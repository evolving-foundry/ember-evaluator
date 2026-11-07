import type { EnvironmentSession } from "./environment.js";
import type { AttemptStepResult, Failure, SolveResult, VerifyResult } from "./result.js";
import type { JsonValue, PreparedTask, SourceLock, TaskRef } from "./task.js";
import type { EffectiveConfig } from "./config.js";
import type { EvaluationKind } from "./result.js";
import type { ActivityListener } from "./activity.js";
import type { VerificationRuntime } from "./verification-runtime.js";

export type BenchmarkRunPlan = {
  tasks: PreparedTask[];
  /** Task-local metadata failures; together with tasks, exactly covers the selection. */
  preparationFailures?: { taskId: string; failure: Failure }[];
  preparation: { defaultTimeoutSeconds: number };
  policy: {
    version: string;
    source: string;
  };
};

export interface Benchmark {
  /** Benchmark-owned reward selection and stop rules after each ordered step. */
  evaluateSteps?(task: PreparedTask, results: AttemptStepResult[]): { verdict: VerifyResult | null; continue: boolean };
  readonly verificationRuntime?: VerificationRuntime;
  readonly evaluationKind?: EvaluationKind;
  /** Pure cross-component checks, also invoked for dry-run; no resource allocation. */
  validateRun?(config: EffectiveConfig): void;
  /** Metadata only: no containers, image builds, or model calls. */
  planRun?(refs: TaskRef[], source: SourceLock, signal: AbortSignal, activity?: ActivityListener): Promise<BenchmarkRunPlan>;
  /** Validate a locked source even when a completed run has no tasks to restart. */
  readonly validateSourceOnCompletedResume?: boolean;
  resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock>;
  enumerate(source: SourceLock, signal: AbortSignal, activity?: ActivityListener): AsyncIterable<TaskRef>;
  prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal, activity?: ActivityListener): Promise<PreparedTask>;
  /** Validate an answer or measurement evidence; throw VerificationError to retain incomplete evidence without a score. */
  verify(
    task: PreparedTask,
    result: SolveResult,
    session: EnvironmentSession | null,
    signal: AbortSignal,
  ): Promise<VerifyResult>;
  /** Textual reference answer for held-in evidence. Absent means this benchmark has none. */
  discloseAnswer?(task: PreparedTask): JsonValue | null;
}
