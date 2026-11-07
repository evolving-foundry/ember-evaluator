import { isErrorCode, type ErrorCode } from "../errors/registry.js";
import { collectAttemptAccounting } from "../results/attempt-accounting.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "../policies/timeouts.js";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RunComponents } from "../contracts/components.js";
import type { PreparedTask, SourceLock, PhaseTimeoutOverrides } from "../contracts/task.js";
import type {
  EnvironmentSession,
  EnvironmentSpec,
  RuntimeInstallation,
  TransferArtifact,
} from "../contracts/environment.js";
import type { PreparedSolver } from "../contracts/solver.js";
import type { VerificationRuntimeSession } from "../contracts/verification-runtime.js";
import { withPreparationTimeout, DEFAULT_PREPARATION_TIMEOUT_SECONDS } from "../preparation/preparation-timeout.js";
import { materializeVerificationRuntime } from "../preparation/verification-runtime.js";
import type { DispatchEntry } from "../preparation/task-preparation.js";
import {
  TRAJECTORY_EVIDENCE_PATH,
  type AttemptRecord,
  type Collection,
  type Failure,
  type FileManifest,
  type Phase,
  type AttemptStepResult,
} from "../contracts/result.js";
import { archiveStep, clearStepOutputs, combineStepTrajectories, sumStepSolves } from "../artifacts/step-evidence.js";
import { buildFileManifest } from "../artifacts/artifacts.js";
import { readTrajectoryPrefix } from "../artifacts/trajectory-recovery.js";
import { redactDiagnostic, redactEvidence } from "../errors/diagnostics.js";
import { assertJsonValue } from "../validation/input.js";
import { VerificationError } from "../errors/verification-error.js";
import { PhaseTimeoutError } from "../policies/phase-timeout.js";
import type { ProgressListener } from "../progress/progress.js";
import { LiveOperation } from "../progress/live-progress.js";
import type { ActivityListener } from "../contracts/activity.js";
import { finalizeAttemptOutcome, assertEvaluationVerdict, timeoutCancellation, applyAttemptFailure, isAgentTimeout } from "../results/evaluation-outcome.js";
import { classifyError, normalizeFailure, type ErrorContext } from "../errors/classify.js";
import { EvaluatorError } from "../errors/evaluator-error.js";
import { assertSolveResult, assertVerifyResult } from "../results/record-validation.js";
import { readCollectOutput } from "../artifacts/collect-output.js";

export type RunTaskOptions = PhaseTimeoutOverrides & {
  timeoutSeconds?: number;
  cleanupTimeoutMs?: number;
  preparationConcurrency?: number;
  environmentTimeoutSeconds?: number;
  sensitiveValues?: readonly string[];
  onProgress?: ProgressListener;
  /** When true, persist the solver prompt and any textual reference answer. */
  includeTaskAnswer?: boolean;
};

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

class UnsupportedRuntimeInstallationError extends Error {
  readonly code: ErrorCode = "ENV_RUNTIME_INSTALL_FAILED";
  constructor() {
    super("The selected environment does not support solver runtime installation");
  }
}

async function trajectoryState(
  root: string,
  files: FileManifest,
  key: AttemptRecord["key"],
  started: boolean,
): Promise<Collection["trajectory"]> {
  if (!files.files.some(file => file.path === TRAJECTORY_EVIDENCE_PATH)) return started ? "missing" : "not-produced";
  if (!files.files.some(file => file.path === "agent/session.jsonl")) return "partial";
  const prefix = await readTrajectoryPrefix(root, key);
  return prefix.state === "complete" ? "complete" : "partial";
}

export async function runTask(
  { job, preparation }: DispatchEntry,
  components: RunComponents,
  source: SourceLock,
  signal: AbortSignal,
  options: RunTaskOptions = {},
): Promise<AttemptRecord> {
  const dependenciesReady = preparation.state === "ready";
  const readiness = preparation.state === "ready" ? preparation.readiness : undefined;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 60_000;
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    !Number.isFinite(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  )
    throw new TypeError("Invalid task time budget");
  for (const value of [options.solveTimeoutSeconds, options.verifyTimeoutSeconds]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new TypeError("Invalid phase time budget");
  }
  const key = { runId: job.runId, taskId: job.taskId, attemptId: job.attemptId };
  const progress = (phase: Phase, message: string) =>
    options.onProgress?.({ phase, message, taskId: job.taskId, attemptId: job.attemptId });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  progress("store", "Allocating attempt output");
  const paths = await components.store.allocate(key).catch(cause => {
    throw new EvaluatorError("STORE_WRITE_FAILED", "Cannot allocate attempt output", {}, { cause });
  });
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Task deadline exceeded", "TimeoutError")),
    timeoutSeconds * 1000,
  );
  timer.unref();
  const taskSignal = AbortSignal.any([signal, deadline.signal]);
  const record: AttemptRecord = {
    evaluationKind: components.benchmark.evaluationKind ?? "quality",
    ...(readiness === undefined ? {} : { readiness: structuredClone(readiness) }),
    key,
    executionStatus: "failed", scoreStatus: "invalid", cleanupStatus: "cleaned",
    solve: null,
    verdict: null,
    errors: [],
    collection: { trajectory: "not-produced", artifacts: "not-produced" },
    environments: { solve: null, verify: null },
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    phaseDurationMs: {},
  };
  const preparationElapsedMs = { solve: 0, verify: 0 };
  let phase: Phase = "prepare";
  let activity: ActivityListener | undefined;
  const currentPhase = (): Phase => phase;
  let prepared: PreparedTask | undefined;
  let multiTask: PreparedTask | undefined;
  let activeStep: AttemptStepResult | undefined;
  let stepErrorStart = 0;
  const archivedSteps = new Set<string>();
  let solveSession: EnvironmentSession | undefined;
  let solverHandle: PreparedSolver | undefined;
  let solveStarted = false;
  let exported = false;
  let resourceAdmissionClosed = false;
  const sessions: EnvironmentSession[] = [];
  const preparedSolvers: PreparedSolver[] = [];
  const verificationSessions: VerificationRuntimeSession[] = [];
  let verificationSession: VerificationRuntimeSession | undefined;
  const pending = new Set<Promise<unknown>>();
  const transferArtifactName = (spec: PreparedTask["transfer"]): string | null => {
    if (spec === null) return null;
    switch (spec.kind) {
      case "git-patch": return "model.patch";
      case "artifacts": return "artifacts.tar";
      default: return "workspace.tar";
    }
  };
  let transferTarget: string | null = null;
  const failure = (at: Phase, error: unknown, fallback?: ErrorCode, context = "", cancellation?: ErrorContext["cancellation"]) => {
    let item: Failure;
    if (at === "prepare" && preparation.state === "failed") {
      item = normalizeFailure(preparation.failure, options.sensitiveValues);
    } else {
      const fallbackCode = error instanceof VerificationError ? "VERIFY_RESULT_INVALID" : fallback;
      item = classifyError(error, {
        phase: at,
        ...(fallbackCode ? { fallbackCode } : {}),
        ...(at === "prepare" ? { component: "task-source" } : {}),
        ...(options.sensitiveValues ? { secrets: options.sensitiveValues } : {}),
        ...(cancellation ? { cancellation } : {}),
      });
    }
    if (context) item.message = (redactDiagnostic(context, options.sensitiveValues) + item.message).slice(0, 2048);
    if (item.code === "NETWORK_FAILURE") (item.details ??= {}).logPath = "result.json";
    record.errors.push(item);
  };
  const transferWarnings = (artifact: TransferArtifact, at: Phase) => {
    for (const warning of artifact.warnings ?? []) {
      if (!isErrorCode(warning.code)) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Transfer warning uses an unregistered error code");
      (record.warnings ??= []).push({
        phase: at,
        code: warning.code,
        message: redactDiagnostic(warning.message, options.sensitiveValues),
      });
    }
  };
  const stage = async <T>(
    at: Phase,
    work: (signal: AbortSignal) => Promise<T>,
    activeSignal = taskSignal,
  ): Promise<T> => {
    phase = at;
    const start = performance.now();
    const labels: Partial<Record<Phase, string>> = {
      prepare: "Preparing task",
      install: "Installing solver runtime",
      environment: "Preparing execution environment",
      solve: "Solving task",
      verify: "Verifying result",
      transfer: "Transferring workspace",
      collect: "Collecting execution artifacts",
      cleanup: "Releasing runtime resources",
    };
    progress(at, labels[at] ?? "Starting");
    let limit: number | undefined;
    if (at === "solve") limit = options.solveTimeoutSeconds ?? prepared?.phaseTimeoutSeconds?.solve;
    else if (at === "verify") limit = options.verifyTimeoutSeconds ?? prepared?.phaseTimeoutSeconds?.verify;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
      throw new TypeError(`Invalid ${at} phase time limit`);
    const phaseDeadline = limit === undefined ? null : AbortSignal.timeout(limit * 1000);
    const stageSignal = phaseDeadline === null ? activeSignal : AbortSignal.any([activeSignal, phaseDeadline]);
    const operation = new LiveOperation(options.onProgress, { phase: at, message: labels[at] ?? at,
      taskId: job.taskId, attemptId: job.attemptId }, options.sensitiveValues, undefined,
      `${job.runId}/${job.taskId}/${job.attemptId}/${at}`, at === "environment");
    const previousActivity = activity;
    activity = operation.activity;
    try {
      const result = await bounded(() => {
        const operation = work(stageSignal);
        pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        );
        return operation;
      }, stageSignal);
      operation.finish();
      return result;
    } catch (error) {
      operation.finish(activeSignal.aborted ? "cancelled" : "failed");
      if (phaseDeadline?.aborted && !activeSignal.aborted) throw new PhaseTimeoutError(at);
      throw error;
    } finally {
      activity = previousActivity;
      record.phaseDurationMs[at] = (record.phaseDurationMs[at] ?? 0) + performance.now() - start;
    }
  };
  const environment = async (
    which: "solve" | "verify",
    stageSignal: AbortSignal,
    installation?: RuntimeInstallation,
  ) => {
    const spec = which === "solve" ? prepared!.solveEnv : prepared!.verifyEnv!;
    const environmentSpec: EnvironmentSpec =
      which === "solve" && !dependenciesReady
        ? {
            ...spec,
            runtime: [...spec.runtime, ...components.solver.requirements()],
            ...(installation === undefined ? {} : { installation }),
          }
        : spec;
    const componentActivity = activity;
    const session = await components.environment.prepare(environmentSpec, paths, which, stageSignal,
      which === "verify" && componentActivity ? event => componentActivity({ activity: event.activity ?? true }) : componentActivity);
    if (resourceAdmissionClosed) {
      // The record already reports unconfirmed cleanup if an adapter outlives
      // the budget; still reclaim a late resource without mutating the record.
      const lateCleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
      void bounded(() => session.dispose(lateCleanupSignal), lateCleanupSignal).catch(() => {});
    } else {
      sessions.push(session);
      record.environments[which] = structuredClone(session.metadata);
    }
    return session;
  };
  const prepareSolver = async (session: EnvironmentSession, stageSignal: AbortSignal) => {
    const handle = await components.solver.prepare!(session, { key, paths, signal: stageSignal, ...(activity ? { activity } : {}) });
    if (resourceAdmissionClosed) {
      if (handle.dispose) {
        const lateCleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
        void bounded(() => handle.dispose!(lateCleanupSignal), lateCleanupSignal).catch(() => {});
      }
    } else {
      preparedSolvers.push(handle);
    }
    return handle;
  };
  const quiesceSolve = async (quiesceSignal: AbortSignal) => {
    if (!solveSession) return;
    if (solverHandle?.dispose && preparedSolvers.includes(solverHandle)) {
      await bounded(() => solverHandle!.dispose!(quiesceSignal), quiesceSignal);
      preparedSolvers.splice(preparedSolvers.indexOf(solverHandle), 1);
    }
    if (dependenciesReady && !solveSession.quiesce)
      throw new Error("Batch execution requires EnvironmentSession.quiesce()");
    await solveSession.quiesce?.(quiesceSignal);
  };
  let transitioned = false;
  let collected = false;
  const finishSolve = async (parentSignal: AbortSignal) => {
    if (!prepared || !solveSession || (prepared.verificationMode !== "shared" && !prepared.collect?.length)) return;
    if (!transitioned) {
      await stage("transfer", async stageSignal => {
        if (solverHandle?.dispose && preparedSolvers.includes(solverHandle)) {
          await solverHandle.dispose(stageSignal);
          preparedSolvers.splice(preparedSolvers.indexOf(solverHandle), 1);
        }
        if (!solveSession!.transitionToVerification)
          throw new Error("Environment does not support verification phase transitions");
        await solveSession!.transitionToVerification(
          prepared!.verificationMode === "shared" ? prepared!.verificationNetwork : undefined,
          stageSignal,
        );
      }, parentSignal);
      transitioned = true;
    }
    if (!collected) {
      collected = true;
      for (const [index, hook] of (prepared.collect ?? []).entries()) {
        await stage("collect", async stageSignal => {
          const active = AbortSignal.any([stageSignal, AbortSignal.timeout(Math.ceil(hook.timeoutSeconds * 1000))]);
          const startService = solveSession!.startService;
          if (hook.service && hook.service !== "main" && !startService)
            throw new Error(`Environment cannot collect from service ${hook.service}`);
          const handle = hook.service && hook.service !== "main" && startService
            ? await startService.call(solveSession, hook.service, { ...hook, input: null }, active)
            : await solveSession!.start({ ...hook, input: null }, active);
          const logPath = `collect/${String(index + 1).padStart(3, "0")}`;
          const exit = await readCollectOutput(handle, join(paths.root, logPath), active, options.sensitiveValues);
          if (exit.code !== 0 || exit.signal !== null) {
            const stream = exit.stderr.trim() ? "stderr" : "stdout";
            const detail = exit[stream].trim().slice(-800);
            throw new Error(`Collect hook ${index + 1} (service=${hook.service ?? "main"}) failed: ${exit.code ?? exit.signal}; logs=${logPath}${detail ? `; ${stream}: ${detail}` : ""}`);
          }
        }, parentSignal);
      }
    }
  };
  try {
    if (preparation.state === "failed") {
      const error = new Error(preparation.failure.message);
      Object.assign(error, { code: preparation.failure.code });
      throw error;
    }
    prepared = await stage("prepare", () => preparation.state === "on-demand"
      ? components.benchmark.prepare(job.ref, source, taskSignal, activity)
      : Promise.resolve(preparation.task));
    if (prepared.input.id !== job.taskId) throw new TypeError("Prepared task identity differs from locked selection");
    const prepareEnvironment = <T>(purpose: "solve" | "verify", work: (signal: AbortSignal) => Promise<T>) => {
      if (dependenciesReady) return work(taskSignal);
      phase = "environment";
      const started = performance.now();
      return withPreparationTimeout(purpose,
        options.environmentTimeoutSeconds ?? prepared?.preparationTimeoutSeconds?.[purpose] ?? DEFAULT_PREPARATION_TIMEOUT_SECONDS,
        options.preparationConcurrency ?? 1, taskSignal, work,
        timing => progress("environment", `${purpose} preparation timeout ${timing.timeoutSeconds}s (base ${timing.baseSeconds}s × ${timing.multiplier}; concurrency ${timing.concurrency})`), preparationElapsedMs[purpose])
        .finally(() => { preparationElapsedMs[purpose] += performance.now() - started; });
    };
    if (!dependenciesReady && components.benchmark.verificationRuntime)
      prepared = await prepareEnvironment("verify", preparationSignal =>
        stage("environment", stageSignal => materializeVerificationRuntime(prepared!, components.benchmark, stageSignal, activity), preparationSignal));
    if (dependenciesReady && components.benchmark.verificationRuntime && prepared.verificationRuntime === undefined)
      throw new Error("Prepared task lacks its verification runtime receipt");
    if (prepared.steps) {
      if (!components.benchmark.evaluateSteps) throw new Error("Multi-step Benchmark must implement evaluateSteps()");
      const names = prepared.steps.map(step => step.name);
      if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name)) ||
        prepared.steps.some(step => step.task.steps || step.task.input.id !== job.taskId)) throw new TypeError("Invalid prepared steps");
      multiTask = prepared;
      record.steps = [];
    }
    if (prepared.transfer && prepared.verifyEnv === null)
      throw new TypeError("File transfer requires a verification environment");
    if (prepared.verificationMode === "separate" && prepared.verifyEnv === null)
      throw new TypeError("Separate verification requires a verification environment");
    if (prepared.verificationMode === "shared" && (prepared.verifyEnv !== null || prepared.transfer !== null))
      throw new TypeError("Shared verification must reuse the solve environment without state transfer");
    if (prepared.artifactCollection && prepared.transfer)
      throw new TypeError("Use one declared artifact snapshot or environment transfer");
    const artifactName = transferArtifactName(prepared.transfer ?? prepared.artifactCollection ?? null);
    if (artifactName !== null) transferTarget = join(paths.artifacts, artifactName);
    const solverEnvironment = prepared.solveEnv;
    await prepareEnvironment("solve", async preparationSignal => {
      const installation = !dependenciesReady && components.solver.runtimeInstallation
        ? await stage("install", async stageSignal => {
            const described = await components.solver.runtimeInstallation!(stageSignal);
            stageSignal.throwIfAborted();
            if (components.environment.supportsRuntimeInstallation !== true)
              throw new UnsupportedRuntimeInstallationError();
            await components.environment.installRuntime?.(described, stageSignal, solverEnvironment, activity);
            return described;
          }, preparationSignal)
        : undefined;
      await stage("environment", async stageSignal => {
        solveSession = await environment("solve", stageSignal, installation);
        stageSignal.throwIfAborted();
        if (components.solver.prepare) solverHandle = await prepareSolver(solveSession, stageSignal);
      }, preparationSignal);
    });
    const prepareVerification = () => prepareEnvironment("verify", preparationSignal =>
      stage("environment", stageSignal => environment("verify", stageSignal), preparationSignal));
    for (const [stepIndex, step] of (multiTask?.steps ?? [{ name: "", task: prepared }]).entries()) {
      if (multiTask) {
        prepared = { ...step.task, solveEnv: { ...multiTask.solveEnv, network: step.task.solveEnv.network ?? "bridge",
          ...(step.task.solveEnv.executionUsers ? { executionUsers: step.task.solveEnv.executionUsers } : {}) },
          ...(stepIndex === 0 && multiTask.verificationRuntime !== undefined ? { verificationRuntime: multiTask.verificationRuntime } : {}) };
        stepErrorStart = record.errors.length;
        activeStep = { name: step.name, solve: null, verdict: null, errors: [], startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(), evidencePath: `steps/${step.name}` };
        record.solve = null;
        record.verdict = null;
        exported = false;
        transitioned = false;
        collected = false;
        verificationSession = undefined;
        const name = transferArtifactName(prepared.transfer ?? prepared.artifactCollection ?? null);
        transferTarget = name === null ? null : join(paths.artifacts, name);
        progress("prepare", `Starting step ${stepIndex + 1}/${multiTask.steps!.length}: ${step.name}`);
        if (stepIndex > 0) {
          await stage("transfer", async stageSignal => {
            await clearStepOutputs(paths.root);
            if (!solveSession!.transitionToSolve) throw new Error("Environment does not support returning to the solve phase");
            await solveSession!.transitionToSolve(prepared!.solveEnv.network, stageSignal, prepared!.solveEnv.executionUsers);
            if (components.solver.prepare) solverHandle = await prepareSolver(solveSession!, stageSignal);
          });
          if (components.benchmark.verificationRuntime)
            prepared = await prepareEnvironment("verify", stageSignal => materializeVerificationRuntime(prepared!, components.benchmark, stageSignal, activity));
        }
        if (step.workdirFiles) await stage("prepare", async stageSignal => {
          await solveSession!.upload(step.workdirFiles!, solveSession!.workdir, stageSignal);
          if (step.setupScript) {
            const exit = await readCollectOutput(await solveSession!.start({ executable: "bash", args: ["setup.sh"],
              cwd: solveSession!.workdir, env: {}, input: null }, stageSignal), join(paths.root, "collect/setup"), stageSignal, options.sensitiveValues);
            if (exit.code !== 0 || exit.signal !== null) throw new Error(`Step ${step.name} setup.sh failed: ${exit.code ?? exit.signal}`);
          }
        });
      }
      solveStarted = true;
      try {
        record.solve = await stage("solve", async stageSignal => {
          const input = { id: prepared!.input.id, prompt: prepared!.input.prompt,
            ...(prepared!.input.payload === undefined ? {} : { payload: structuredClone(prepared!.input.payload) }),
            ...(prepared!.input.skillsDirectories === undefined ? {} : { skillsDirectories: [...prepared!.input.skillsDirectories] }),
            ...(prepared!.input.mcpServers === undefined ? {} : { mcpServers: prepared!.input.mcpServers.map(server => ({ name: server.name, transport: server.transport, url: server.url })) }) };
          const context = { key, paths, signal: stageSignal, ...(activity ? { activity } : {}), warning: (warning: { code: ErrorCode; message: string }) => {
            if (!isErrorCode(warning.code)) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Solver warning uses an unregistered error code");
            const item = { phase: "solve" as const, code: warning.code,
              message: redactDiagnostic(warning.message, options.sensitiveValues) };
            (record.warnings ??= []).push(item);
            options.onProgress?.({ phase: "solve", message: `${item.code}: ${item.message}`, taskId: job.taskId,
              attemptId: job.attemptId, warning: true });
          } };
          const solved = await (solverHandle ? solverHandle.solve(input, context) : components.solver.solve(input, solveSession!, context));
          try { assertSolveResult(solved); }
          catch (cause) { throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Solver returned a malformed result", {}, { cause }); }
          return solved;
        });
      } catch (error) {
        if (!prepared.scoreAfterSolveFailure || taskSignal.aborted) throw error;
        failure("solve", error, undefined, "", error instanceof PhaseTimeoutError ? "agent" : undefined);
        // Preserve the missing reply and unknown usage; the native grader decides
        // whether the workspace still earns a reward, including after a timeout.
        record.solve = { finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: { incomplete: true } };
        await stage("transfer", async () => { await Promise.allSettled([...pending]); });
      }
      await finishSolve(taskSignal);
      if (prepared.verificationMode !== "shared" && (solveSession!.quiesce || dependenciesReady))
        await stage("transfer", quiesceSolve);
      let verifier: EnvironmentSession | null = null;
      if (prepared.verificationMode === "shared") {
        verifier = solveSession!;
        record.environments.verify = structuredClone(verifier.metadata);
      }
      if (prepared.artifactCollection) {
        const artifact = await stage("collect", stageSignal =>
          solveSession!.exportState(prepared!.artifactCollection!, transferTarget!, stageSignal),
        );
        exported = true;
        transferWarnings(artifact, "collect");
      }
      let transferred: TransferArtifact | null = null;
      if (prepared.transfer) {
        transferred = await stage("transfer", () =>
          solveSession!.exportState(prepared!.transfer!, transferTarget!, taskSignal),
        );
        exported = true;
        transferWarnings(transferred, "transfer");
      }
      if (!multiTask && prepared.verificationMode !== "shared" && solveSession!.quiesce) {
        await stage("cleanup", async cleanupSignal => {
          await solveSession!.dispose(cleanupSignal);
          sessions.splice(sessions.indexOf(solveSession!), 1);
        });
      }
      if (prepared.verifyEnv) verifier = await prepareVerification();
      if (transferred) await stage("transfer", () => verifier!.restoreState(transferred!, taskSignal));
      if (components.benchmark.verificationRuntime) {
        verificationSession = await stage("environment", async stageSignal => {
          const runtimeActivity = activity;
          const handle = await components.benchmark.verificationRuntime!.prepare(prepared!, prepared!.verificationRuntime!,
            { key, paths, signal: stageSignal, ...(runtimeActivity ? { activity: event => runtimeActivity({ activity: event.activity ?? true }) } : {}) })
            .catch(error => {
              // A rejected allocation may finish its own cleanup after the stage
              // has already returned cancellation. Do not lose that observation.
              if (stageSignal.aborted && !resourceAdmissionClosed &&
                ["CLEANUP_TIMEOUT", "CLEANUP_FAILED"].includes(classifyError(error, { phase: "environment" }).code))
                failure("cleanup", error, "CLEANUP_TIMEOUT", "Verification runtime allocation: ");
              throw error;
            });
          if (resourceAdmissionClosed) {
            const lateCleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
            void bounded(() => handle.dispose(lateCleanupSignal), lateCleanupSignal).catch(() => {});
          } else {
            verificationSessions.push(handle);
            assertJsonValue(handle.metadata, "verification runtime metadata");
            record.environments.verificationRuntime = redactEvidence(handle.metadata, options.sensitiveValues);
          }
          return handle;
        });
      }
      try {
        record.verdict = await stage("verify", async stageSignal => {
          const verdict = await (verificationSession ? verificationSession.verify(record.solve!, verifier, stageSignal)
            : components.benchmark.verify(prepared!, record.solve!, verifier, stageSignal)).catch(error => {
            if (error instanceof VerificationError && !resourceAdmissionClosed) {
              assertJsonValue(error.evidence, "verification failure evidence");
              record.verdict = { passed: null, details: redactEvidence(error.evidence, options.sensitiveValues) };
            }
            throw error;
          });
          try { assertVerifyResult(verdict); }
          catch (cause) { throw new EvaluatorError("VERIFY_RESULT_INVALID", "Benchmark returned a malformed verdict", {}, { cause }); }
          assertEvaluationVerdict(record.evaluationKind, verdict);
          return verdict;
        });
      } catch (error) {
        if (!multiTask?.scoreAfterSolveFailure || taskSignal.aborted) throw error;
        failure("verify", error);
        record.verdict = null;
      }
      if (multiTask && activeStep) {
        activeStep.solve = record.solve;
        activeStep.verdict = record.verdict;
        activeStep.errors = record.errors.slice(stepErrorStart);
        activeStep.finishedAt = new Date().toISOString();
        record.steps!.push(activeStep);
        // Stop all writers and restore host log ownership before copying evidence.
        await stage("collect", async stageSignal => {
          for (const session of sessions.filter(session => session !== solveSession)) {
            await session.dispose(stageSignal);
            sessions.splice(sessions.indexOf(session), 1);
          }
          await solveSession!.quiesce?.(stageSignal);
          await archiveStep(paths.root, record, activeStep!);
          archivedSteps.add(activeStep!.name);
        });
        const decision = components.benchmark.evaluateSteps!(multiTask, record.steps!);
        record.verdict = decision.verdict;
        activeStep = undefined;
        if (!decision.continue) break;
      }
    }
  } catch (error) {
    const infrastructureCancellation = signal.aborted && signal.reason && typeof signal.reason === "object" &&
      "code" in signal.reason && signal.reason.code === "RAY_HEARTBEAT_TIMEOUT";
    const ownedDeadline = deadline.signal.aborted && taskSignal.reason === deadline.signal.reason || error instanceof PhaseTimeoutError;
    const cancellation = timeoutCancellation(record.evaluationKind, infrastructureCancellation,
      signal.aborted, ownedDeadline, currentPhase());
    failure(
      phase,
      error,
      undefined,
      "", cancellation,
    );
    applyAttemptFailure(record);
  } finally {
    clearTimeout(timer);
    const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
    // Partial workspace evidence must be exported while its environment exists.
    const evidenceSpec = prepared?.transfer ?? prepared?.artifactCollection;
    if (solveSession && !exported && (evidenceSpec || prepared?.collect?.length)) {
      try {
        const artifact = await stage(
          "collect",
          async collectSignal => {
            // Cancellation rejects bounded() before the solver has finished
            // stopping its container. Do not race that stop with evidence export.
            await Promise.allSettled([...pending]);
            collectSignal.throwIfAborted();
            if (solveStarted) {
              try { await finishSolve(collectSignal); }
              catch (error) {
                failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE", "Before evidence collection: ");
              }
            }
            if (!evidenceSpec) return null;
            // A failed hook must not discard existing files. Export still
            // requires successful quiescence so writers cannot race the snapshot.
            await quiesceSolve(collectSignal);
            return solveSession!.exportState(evidenceSpec, transferTarget!, collectSignal);
          },
          cleanupSignal,
        );
        if (artifact) {
          exported = true;
          transferWarnings(artifact, "collect");
        }
      } catch (error) {
        failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE");
      }
    }
    const disposeVerificationSessions = async () => {
      const disposalSignal = AbortSignal.timeout(cleanupTimeoutMs);
      await Promise.all(verificationSessions.splice(0).map(async handle => {
        try { await stage("cleanup", () => handle.dispose(disposalSignal), disposalSignal); }
        catch (error) { failure("cleanup", error, disposalSignal.aborted ? "CLEANUP_TIMEOUT" : "CLEANUP_FAILED", "Verification runtime: "); }
      }));
    };
    const disposePreparedSolvers = async () => {
      const disposalSignal = AbortSignal.timeout(cleanupTimeoutMs);
      await Promise.all(
        preparedSolvers
          .splice(0)
          .reverse()
          .map(async handle => {
            if (!handle.dispose) return;
            try {
              await stage("cleanup", () => handle.dispose!(disposalSignal), disposalSignal);
            } catch (error) {
              failure(
                "cleanup",
                error,
                disposalSignal.aborted ? "CLEANUP_TIMEOUT" : "CLEANUP_FAILED",
                "Prepared solver: ",
              );
            }
          }),
      );
    };
    const disposeSessions = async () => {
      // Collection or pending preparation may already have exhausted the first
      // cleanup budget. Every admitted batch still gets an independent bounded
      // disposal opportunity; an expired signal must not suppress dispose().
      const disposalSignal = AbortSignal.timeout(cleanupTimeoutMs);
      // Start every disposal before waiting so one broken adapter cannot stop
      // us from requesting cleanup of the other environment.
      await Promise.all(
        sessions
          .splice(0)
          .reverse()
          .map(async session => {
            try {
              await stage("cleanup", () => session.dispose(disposalSignal), disposalSignal);
            } catch (error) {
              failure(
                "cleanup",
                error,
                disposalSignal.aborted ? "CLEANUP_TIMEOUT" : "CLEANUP_FAILED",
                `Environment session ${session.id}: `,
              );
            }
          }),
      );
    };
    await disposeVerificationSessions();
    await disposePreparedSolvers();
    await disposeSessions();
    if (pending.size) {
      try {
        await bounded(() => Promise.allSettled([...pending]), cleanupSignal);
      } catch (error) {
        failure("cleanup", error, "CLEANUP_TIMEOUT");
      }
    }
    // A preparation which honored cancellation by returning its resource can
    // have registered a session while we waited for pending work to settle.
    // Close admission before the final snapshot: arrivals during that drain
    // must self-dispose and cannot mutate the result awaiting publication.
    resourceAdmissionClosed = true;
    await disposeVerificationSessions();
    await disposePreparedSolvers();
    await disposeSessions();
  }
  if (multiTask && record.steps) {
    if (activeStep) {
      activeStep.solve = record.solve;
      activeStep.verdict = record.verdict;
      activeStep.errors = record.errors.slice(stepErrorStart);
      activeStep.finishedAt = new Date().toISOString();
      if (!record.steps.some(step => step.name === activeStep!.name)) record.steps.push(activeStep);
      if (!archivedSteps.has(activeStep.name)) await archiveStep(paths.root, record, activeStep).catch(error => failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE"));
    }
    if (record.steps.length) {
      record.solve = sumStepSolves(record.steps);
      if (multiTask.scoreAfterSolveFailure && !signal.aborted)
        record.verdict = components.benchmark.evaluateSteps!(multiTask, record.steps).verdict;
      await combineStepTrajectories(paths.root, record).catch(error => failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE"));
    } else delete record.steps;
  }
  // Hash after processes stop writing; store verifies the same inventory before
  // publishing result.json. Store allocation/publication errors remain global.
  const required = solveStarted ? [TRAJECTORY_EVIDENCE_PATH, "agent/session.jsonl"] : [];
  const artifactName = transferArtifactName(prepared?.transfer ?? prepared?.artifactCollection ?? null);
  if (solveSession && artifactName !== null) required.push(`artifacts/${artifactName}`);
  const collectionStart = performance.now();
  progress("collect", "Collecting trajectory and artifacts");
  const files = await buildFileManifest(paths.root, required);
  record.collection.trajectory = await trajectoryState(paths.root, files, key, solveStarted);
  const artifactFiles = files.files.filter(file => file.path.startsWith("artifacts/") || file.path.startsWith("logs/artifacts/"));
  const missingArtifacts = files.missing.some(file => file.path.startsWith("artifacts/"));
  record.collection.artifacts = missingArtifacts
    ? artifactFiles.length
      ? "partial"
      : "missing"
    : artifactFiles.length
      ? "complete"
      : "not-produced";
  if (files.files.some(file => file.path === TRAJECTORY_EVIDENCE_PATH)) {
    record.trajectory = TRAJECTORY_EVIDENCE_PATH;
  }
  if (files.missing.length || (solveStarted && record.collection.trajectory !== "complete")) {
    if (isAgentTimeout(record) && files.missing.length === 0 && record.collection.trajectory === "partial")
      (record.warnings ??= []).push({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE", message: "Agent solve deadline ended the trajectory before completion; all required files were collected" });
    else if (record.errors.some(error => error.code === "NETWORK_FAILURE") && files.missing.every(file => [TRAJECTORY_EVIDENCE_PATH, "agent/session.jsonl"].includes(file.path)))
      (record.warnings ??= []).push({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE", message: "Network failure ended the solver trajectory before completion" });
    else failure("collect", new Error("Task evidence is missing or partial"), "ARTIFACT_COLLECTION_INCOMPLETE");
  }
  record.phaseDurationMs.collect = (record.phaseDurationMs.collect ?? 0) + performance.now() - collectionStart;
  if (options.includeTaskAnswer === true && prepared) {
    const answer = components.benchmark.discloseAnswer?.(prepared);
    record.task = answer === null || answer === undefined ? { prompt: prepared.input.prompt } : { prompt: prepared.input.prompt, answer };
  }
  record.finishedAt = new Date().toISOString();
  record.durationMs = performance.now() - started;
  await collectAttemptAccounting(paths.root, record);
  finalizeAttemptOutcome(record, multiTask?.scoreAfterSolveFailure ?? prepared?.scoreAfterSolveFailure);
  progress("store", "Saving attempt result");
  await components.store.commit(record, files).catch(cause => {
    throw new EvaluatorError("STORE_WRITE_FAILED", "Cannot persist attempt result", {}, { cause });
  });
  return record;
}
