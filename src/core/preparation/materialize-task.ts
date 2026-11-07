import { performance } from "node:perf_hooks";
import type { RunComponents } from "../contracts/components.js";
import type { EnvironmentSpec, RuntimeInstallation } from "../contracts/environment.js";
import type { TaskPreparationContext, TaskPreparer } from "../contracts/preparation.js";
import type { ProgressListener } from "../progress/progress.js";
import type { DescribedTask, ReadyDependencies } from "./task-preparation.js";
import { imagePreparationProgress } from "./preparation-progress.js";
import { LiveOperation } from "../progress/live-progress.js";
import { materializeVerificationRuntime } from "./verification-runtime.js";
import { withPreparationTimeout } from "./preparation-timeout.js";

async function waitForInstallation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Reuse the solver installation within one round; placement and queues belong to the scheduler. */
export function createTaskMaterializer(
  components: Pick<RunComponents, "benchmark" | "environment" | "solver">,
  options: { sensitiveValues?: readonly string[]; onProgress?: ProgressListener } = {},
) {
  let installation: Promise<RuntimeInstallation | undefined> | undefined;
  return async ({ task }: DescribedTask, signal: AbortSignal, context: TaskPreparationContext): Promise<ReadyDependencies> => {
    signal.throwIfAborted();
    if (!components.environment.materialize) throw new Error("Environment must implement materialize() for planned preparation");
    const { onProgress, sensitiveValues } = options;
    const { timing, roundId, attemptId } = context;
    const base = { phase: "prepare", taskId: task.input.id, ...(attemptId ? { attemptId } : {}) };
    const materialize = async (spec: EnvironmentSpec, purpose: "solve" | "verify", stageSignal: AbortSignal) => {
      stageSignal.throwIfAborted();
      const phase = purpose === "solve" ? "solveEnvironment" : "verifyEnvironment";
      const started = performance.now();
      const operation = new LiveOperation(onProgress, { ...base,
        message: `Preparing ${purpose === "solve" ? "solve" : "verify"} image and runtime environment` }, sensitiveValues, undefined,
        `${roundId}/${task.input.id}/${phase}`, purpose === "verify" || task.verifyEnv === null);
      try {
        const ready = await components.environment.materialize!(spec, stageSignal,
          imagePreparationProgress(task.input.id, purpose, onProgress),
          purpose === "verify" ? event => operation.activity({ activity: event.activity ?? true }) : operation.activity,
          { taskId: task.input.id, phase: purpose });
        stageSignal.throwIfAborted();
        if (timing && ready.preparationTiming) {
          timing.imagePhaseDurationMs ??= {};
          timing.imagePhaseDurationMs[purpose] = ready.preparationTiming;
        }
        operation.finish();
        return ready;
      } catch (error) { operation.finish(signal.aborted ? "cancelled" : "failed"); throw error; }
      finally { if (timing) timing.phaseDurationMs[phase] = performance.now() - started; }
    };
    const stage = <T>(purpose: "solve" | "verify", work: (signal: AbortSignal) => Promise<T>) =>
      withPreparationTimeout(purpose,
        context.environmentTimeoutSeconds ?? task.preparationTimeoutSeconds?.[purpose] ?? context.defaultTimeoutSeconds,
        context.concurrency, signal, work, budget => {
          if (timing) (timing.environmentTimeouts ??= {})[purpose] = budget;
          onProgress?.({ ...base, message: `Preparing ${purpose} environment; timeout ${budget.timeoutSeconds}s (base ${budget.baseSeconds}s × ${budget.multiplier}; preparation concurrency ${budget.concurrency})` });
        });
    const solveEnv = await stage("solve", async stageSignal => {
      // A task may stop waiting, but must not cancel a description shared by its peers.
      installation ??= components.solver.runtimeInstallation?.(context.roundSignal) ?? Promise.resolve(undefined);
      const runtime = await waitForInstallation(installation, stageSignal);
      if (runtime && !components.environment.supportsRuntimeInstallation)
        throw new Error("Environment cannot install the solver runtime");
      return materialize({ ...task.solveEnv,
        runtime: [...task.solveEnv.runtime, ...components.solver.requirements()], ...(runtime ? { installation: runtime } : {}),
      }, "solve", stageSignal);
    });
    if (!task.verifyEnv && !task.steps?.some(step => step.task.verifyEnv) && !components.benchmark.verificationRuntime)
      return { state: "ready", task: { ...task, solveEnv } };
    const preparedTask = await stage("verify", async stageSignal => {
      const verifyEnv = task.verifyEnv ? await materialize(task.verifyEnv, "verify", stageSignal) : null;
      const prepared = { ...task, solveEnv, verifyEnv };
      if (task.steps) {
        prepared.steps = [];
        for (const [index, step] of task.steps.entries()) {
          const stepVerifyEnv = index === 0 ? verifyEnv : step.task.verifyEnv ? await materialize(step.task.verifyEnv, "verify", stageSignal) : null;
          prepared.steps.push({ ...step, task: { ...step.task, verifyEnv: stepVerifyEnv } });
        }
      }
      if (!components.benchmark.verificationRuntime) return prepared;
      const started = performance.now();
      const operation = new LiveOperation(onProgress, { ...base, message: "Preparing verifier runtime" }, sensitiveValues, undefined,
        `${roundId}/${task.input.id}/verification-runtime`, true);
      try {
        const ready = await materializeVerificationRuntime(prepared, components.benchmark, stageSignal, operation.activity);
        stageSignal.throwIfAborted();
        operation.finish();
        return ready;
      } catch (error) { operation.finish(signal.aborted ? "cancelled" : "failed"); throw error; }
      finally {
        if (timing) timing.phaseDurationMs.verifyEnvironment = (timing.phaseDurationMs.verifyEnvironment ?? 0) + performance.now() - started;
      }
    });
    return { state: "ready", task: preparedTask };
  };
}

/** Scheduler plugins still exchange PreparedTask through their public preparation callback. */
export function createTaskPreparer(...args: Parameters<typeof createTaskMaterializer>): TaskPreparer {
  const materialize = createTaskMaterializer(...args);
  return async (task, signal, context) => (await materialize({ state: "described", task }, signal, context)).task;
}
