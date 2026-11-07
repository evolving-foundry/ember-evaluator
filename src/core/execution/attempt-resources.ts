import type { ActivityListener } from "../contracts/activity.js";
import type { RunComponents } from "../contracts/components.js";
import type { EnvironmentSession, EnvironmentSpec, RuntimeInstallation } from "../contracts/environment.js";
import type { AttemptPaths, AttemptRecord, Phase } from "../contracts/result.js";
import type { AttemptContext, PreparedSolver } from "../contracts/solver.js";
import type { PreparedTask, PublicTask } from "../contracts/task.js";
import type { VerificationRuntimeSession } from "../contracts/verification-runtime.js";
import { classifyError, type ErrorContext } from "../errors/classify.js";
import { redactEvidence } from "../errors/diagnostics.js";
import type { ErrorCode } from "../errors/registry.js";
import { assertJsonValue } from "../validation/input.js";

export type RunAttemptStage = <T>(
  phase: Phase,
  work: (signal: AbortSignal, activity: ActivityListener) => Promise<T>,
  parentSignal?: AbortSignal,
) => Promise<T>;

export type RecordAttemptFailure = (
  phase: Phase, error: unknown, fallback?: ErrorCode, context?: string, cancellation?: ErrorContext["cancellation"],
) => void;

type Resource = { dispose?(signal: AbortSignal): Promise<void> };

async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work(), cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function privateActivity(activity: ActivityListener): ActivityListener {
  return event => activity({ activity: event.activity ?? true });
}

export class AttemptResources {
  private readonly sessions: EnvironmentSession[] = [];
  private readonly preparedSolvers: PreparedSolver[] = [];
  private readonly verificationSessions: VerificationRuntimeSession[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly disposing = new Map<Resource, { operation: Promise<void>; signal: AbortSignal }>();
  private solveSession: EnvironmentSession | undefined;
  private solverHandle: PreparedSolver | undefined;
  private closed = false;

  constructor(
    private readonly components: RunComponents,
    private readonly record: AttemptRecord,
    private readonly paths: AttemptPaths,
    private readonly dependenciesReady: boolean,
    private readonly cleanupTimeoutMs: number,
    private readonly failure: RecordAttemptFailure,
    private readonly secrets: readonly string[] | undefined,
  ) {}

  get hasSolveEnvironment(): boolean { return this.solveSession !== undefined; }
  get canQuiesceSolve(): boolean { return this.solveSession?.quiesce !== undefined; }
  get acceptingResources(): boolean { return !this.closed; }

  get solveEnvironment(): EnvironmentSession {
    if (!this.solveSession) throw new Error("Solve environment is unavailable");
    return this.solveSession;
  }

  runOperation<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return bounded(() => {
      const operation = work();
      this.pending.add(operation);
      void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
      return operation;
    }, signal);
  }

  async waitForPending(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private admit<T extends Resource>(resource: T, list: T[]): boolean {
    if (this.closed) {
      // Cancellation can return before an adapter hands back its resource.
      const signal = AbortSignal.timeout(this.cleanupTimeoutMs);
      void bounded(async () => resource.dispose?.(signal), signal).catch(() => {});
      return false;
    }
    list.push(resource);
    return true;
  }

  private async openEnvironment(
    spec: EnvironmentSpec, purpose: "solve" | "verify", signal: AbortSignal, activity: ActivityListener,
  ): Promise<EnvironmentSession> {
    const session = await this.components.environment.prepare(spec, this.paths, purpose, signal,
      purpose === "verify" ? privateActivity(activity) : activity);
    if (this.admit(session, this.sessions)) this.record.environments[purpose] = structuredClone(session.metadata);
    return session;
  }

  private async prepareSolver(signal: AbortSignal, activity: ActivityListener): Promise<void> {
    const solver = this.components.solver;
    if (!solver.prepare) return;
    const handle = await solver.prepare(this.solveEnvironment, { key: this.record.key, paths: this.paths, signal, activity });
    if (this.admit(handle, this.preparedSolvers)) this.solverHandle = handle;
  }

  async openSolve(spec: EnvironmentSpec, installation: RuntimeInstallation | undefined, signal: AbortSignal, activity: ActivityListener): Promise<void> {
    const environmentSpec = this.dependenciesReady ? spec : {
      ...spec,
      runtime: [...spec.runtime, ...this.components.solver.requirements()],
      ...(installation === undefined ? {} : { installation }),
    };
    const session = await this.openEnvironment(environmentSpec, "solve", signal, activity);
    if (!this.closed) this.solveSession = session;
    signal.throwIfAborted();
    await this.prepareSolver(signal, activity);
  }

  openVerification(spec: EnvironmentSpec, signal: AbortSignal, activity: ActivityListener): Promise<EnvironmentSession> {
    return this.openEnvironment(spec, "verify", signal, activity);
  }

  shareSolveWithVerification(): EnvironmentSession {
    const session = this.solveEnvironment;
    this.record.environments.verify = structuredClone(session.metadata);
    return session;
  }

  async openPrivateVerifier(task: PreparedTask, signal: AbortSignal, activity: ActivityListener): Promise<VerificationRuntimeSession> {
    const runtime = this.components.benchmark.verificationRuntime;
    if (!runtime || task.verificationRuntime === undefined) throw new Error("Missing verification runtime receipt");
    const handle = await runtime.prepare(task, task.verificationRuntime,
      { key: this.record.key, paths: this.paths, signal, activity: privateActivity(activity) }).catch(error => {
      if (signal.aborted && !this.closed &&
        ["CLEANUP_TIMEOUT", "CLEANUP_FAILED"].includes(classifyError(error, { phase: "environment" }).code))
        this.failure("cleanup", error, "CLEANUP_TIMEOUT", "Verification runtime allocation: ");
      throw error;
    });
    if (this.admit(handle, this.verificationSessions)) {
      assertJsonValue(handle.metadata, "verification runtime metadata");
      this.record.environments.verificationRuntime = redactEvidence(handle.metadata, this.secrets);
    }
    return handle;
  }

  solve(input: PublicTask, context: AttemptContext) {
    return this.solverHandle ? this.solverHandle.solve(input, context) : this.components.solver.solve(input, this.solveEnvironment, context);
  }

  private async dispose(resource: Resource, signal: AbortSignal, retryAborted = false): Promise<void> {
    if (!resource.dispose) return;
    const current = this.disposing.get(resource);
    if (current) {
      try { return await current.operation; }
      catch (error) {
        if (!retryAborted || !current.signal.aborted || signal.aborted) throw error;
      }
    }
    const operation = resource.dispose(signal);
    this.disposing.set(resource, { operation, signal });
    try { await operation; }
    finally { this.disposing.delete(resource); }
  }

  private async release<T extends Resource>(resource: T, list: T[], signal: AbortSignal): Promise<void> {
    if (!list.includes(resource)) return;
    await this.dispose(resource, signal);
    const index = list.indexOf(resource);
    if (index >= 0) list.splice(index, 1);
  }

  private async releaseSolver(signal: AbortSignal): Promise<void> {
    if (!this.solverHandle) return;
    await this.release(this.solverHandle, this.preparedSolvers, signal);
    this.solverHandle = undefined;
  }

  async transitionToVerification(network: EnvironmentSpec["network"], signal: AbortSignal): Promise<void> {
    await this.releaseSolver(signal);
    signal.throwIfAborted();
    const session = this.solveEnvironment;
    if (!session.transitionToVerification) throw new Error("Environment does not support verification phase transitions");
    await session.transitionToVerification(network, signal);
  }

  async quiesceSolve(signal: AbortSignal): Promise<void> {
    await this.releaseSolver(signal);
    signal.throwIfAborted();
    const session = this.solveEnvironment;
    if (this.dependenciesReady && !session.quiesce) throw new Error("Batch execution requires EnvironmentSession.quiesce()");
    await session.quiesce?.(signal);
  }

  releaseSolveEnvironment(signal: AbortSignal): Promise<void> {
    return this.release(this.solveEnvironment, this.sessions, signal);
  }

  async finishStep(signal: AbortSignal): Promise<void> {
    for (const verifier of this.verificationSessions.slice()) await this.release(verifier, this.verificationSessions, signal);
    for (const session of this.sessions.filter(session => session !== this.solveSession))
      await this.release(session, this.sessions, signal);
    await this.releaseSolver(signal);
    signal.throwIfAborted();
    await this.solveEnvironment.quiesce?.(signal);
  }

  async returnToSolve(spec: EnvironmentSpec, signal: AbortSignal, activity: ActivityListener): Promise<void> {
    const session = this.solveEnvironment;
    if (!session.transitionToSolve) throw new Error("Environment does not support returning to the solve phase");
    await session.transitionToSolve(spec.network, signal, spec.executionUsers);
    signal.throwIfAborted();
    await this.prepareSolver(signal, activity);
  }

  async close(stage: RunAttemptStage, waitSignal: AbortSignal): Promise<void> {
    const disposeBatch = async <T extends Resource>(list: T[], label: (resource: T) => string) => {
      const signal = AbortSignal.timeout(this.cleanupTimeoutMs);
      await Promise.all(list.splice(0).reverse().map(async resource => {
        if (!resource.dispose) return;
        try { await stage("cleanup", () => this.dispose(resource, signal, true), signal); }
        catch (error) { this.failure("cleanup", error, signal.aborted ? "CLEANUP_TIMEOUT" : "CLEANUP_FAILED", label(resource)); }
      }));
    };
    const drain = async () => {
      await disposeBatch(this.verificationSessions, () => "Verification runtime: ");
      await disposeBatch(this.preparedSolvers, () => "Prepared solver: ");
      await disposeBatch(this.sessions, session => `Environment session ${session.id}: `);
    };
    await drain();
    if (this.pending.size) {
      try { await bounded(() => this.waitForPending(), waitSignal); }
      catch (error) { this.failure("cleanup", error, "CLEANUP_TIMEOUT"); }
    }
    // A pending allocation may return while we wait. Close admission before
    // the last drain so later arrivals dispose themselves with a fresh budget.
    this.closed = true;
    await drain();
  }
}
