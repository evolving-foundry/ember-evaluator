import { networkSnapshot } from "../../../config/network-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { PluginFactoryContext } from "../../../core/contracts/plugin.js";
import type { SchedulerContext, SchedulerPreparationContext, TaskScheduler, TaskJob, TaskExecutor } from "../../../core/contracts/scheduler.js";
import type { AttemptKey, AttemptRecord, AttemptSummary, Failure, PreparationRound } from "../../../core/contracts/result.js";
import { PACKAGE_RUNTIME_ID } from "../../../core/results/runtime-identity.js";
import { loadPackageDigest } from "../../../infrastructure/provenance/package.js";
import { LocalScheduler } from "../local/scheduler.js";
import { runPreparationQueue } from "../shared/preparation-queue.js";
import { hasUnconfirmedCleanup, isEvaluationComplete } from "../../../core/results/evaluation-outcome.js";
import { saveInvalidAttempt } from "../../../core/results/invalid-attempt.js";
import { formatError } from "../../../core/errors/diagnostics.js";
import { failureDecision, requiresDispatchStop } from "../../../core/policies/error-policy.js";
import { classifyError } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { isErrorCode } from "../../../core/errors/registry.js";
import { RayClient, type RayResult } from "../../../infrastructure/ray/client.js";
import { RayControl } from "../../../infrastructure/ray/control.js";
import { projectRemoteJob, projectPortableSelection, validateRemoteJob, type RemotePreparation } from "../../../infrastructure/ray/protocol.js";
import { startTransferReceiver } from "../../../infrastructure/transfer/https.js";
import { createDistributedReceiver } from "../../stores/distributed-receiver.js";
import type { RaySchedulerConfig } from "../../../config/ray.js";
import type { ConfigTransportLookup } from "../../../core/contracts/config-transport.js";
import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext, ScheduledPreparation, TaskPlacement } from "../../../core/contracts/preparation.js";
import { runPreparationRound } from "../../../core/preparation/preparation-round.js";
import { preparationConcurrency } from "../../../core/preparation/preparation-timeout.js";
import type { ImageCleanupRequest, ImageCleanupNode } from "../../../core/contracts/image-cleanup.js";
import type { Selection } from "../../../core/contracts/config.js";

export class RayScheduler implements TaskScheduler {
  readonly executionLocation = "remote" as const;
  private context: SchedulerContext | undefined;
  private preparationContext: SchedulerPreparationContext | undefined;
  private control: RayControl | undefined;
  private client: RayClient | undefined;
  private server: Awaited<ReturnType<typeof startTransferReceiver>> | undefined;
  private packageDigest = "";
  private previous: AttemptSummary[] = [];
  private readonly prepared = new Map<string, RemotePreparation>();
  constructor(
    private readonly config: RaySchedulerConfig,
    private readonly runtime: PluginFactoryContext,
    private readonly configTransport?: ConfigTransportLookup,
  ) {}
  async setup(context: SchedulerContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.preparationContext) throw new Error("Ray scheduler cannot be reused for another session");
    if (!context.store.importAttempt || !context.store.updateRemoteAttempt)
      throw new Error("Ray requires a store with remote admission and lifecycle support");
    this.context = context;
    this.previous = await context.store.listAttempts();
    const config = context.safeConfig as unknown as EffectiveConfig;
    await this.connect({ session: context.run, safeConfig: context.safeConfig,
      ...(context.log ? { log: context.log } : {}), ...(context.onProgress ? { onProgress: context.onProgress } : {}) }, signal,
      createDistributedReceiver(join(config.output.directory, context.run.runId, ".transfers"), context.store),
      update => context.store.updateRemoteAttempt!(update));
  }
  async setupPreparation(context: SchedulerPreparationContext, signal: AbortSignal): Promise<void> {
    await this.connect(context, signal);
  }
  async cleanupImages(request: ImageCleanupRequest,
    environment: Selection, pluginVersions: Record<string, string>, signal: AbortSignal): Promise<ImageCleanupNode[]> {
    const client = this.createClient();
    try {
      await client.start(signal);
      const payload = { environment: projectPortableSelection(environment, "environment", this.configTransport),
        pluginVersions, packageDigest: await loadPackageDigest(), request: { ...request, execute: false } };
      const preview = await client.cleanupImages(payload, client.nodes, signal);
      if (!request.execute || signal.aborted) return preview;
      const conflicting = new Set(preview.filter(node => node.daemonId && preview.some(other => other.nodeId !== node.nodeId && other.daemonId === node.daemonId && other.inventoryId !== node.inventoryId)).map(node => node.daemonId));
      for (const node of preview) if (conflicting.has(node.daemonId)) {
        node.error = "Nodes share a Docker daemon but have different image inventories; configure a shared EVALUATOR_CACHE_DIR before deleting images";
      }
      const seen = new Set<string>();
      const nodes = preview.filter(node => {
        if (node.error || !node.daemonId || seen.has(node.daemonId)) return false;
        seen.add(node.daemonId); return true;
      }).map(node => node.nodeId);
      const results = nodes.length ? await client.cleanupImages({ ...payload, request }, nodes, signal) : [];
      return [...results, ...preview.filter(node => node.error), ...preview.filter(node => !nodes.includes(node.nodeId) && !node.error).map(node => ({
        nodeId: node.nodeId, daemonId: node.daemonId, items: [],
      }))];
    } finally { await client.close(); }
  }
  private async connect(context: SchedulerPreparationContext, signal: AbortSignal,
    receiver?: ReturnType<typeof createDistributedReceiver>,
    update?: ConstructorParameters<typeof RayControl>[1]): Promise<void> {
    signal.throwIfAborted();
    if (this.preparationContext) throw new Error("Ray scheduler cannot be reused for another session");
    this.preparationContext = context;
    this.packageDigest = await loadPackageDigest();
    if (context.session.pluginVersions[PACKAGE_RUNTIME_ID] !== this.packageDigest)
      throw new Error("Coordinator package differs from locked Ray run");
    const token = process.env[this.config.collector.tokenEnv];
    if (!token || Object.values(this.runtime.services).some(binding => binding.auth.value === token))
      throw new Error("Ray requires a separate transfer token environment variable");
    this.control = new RayControl(this.runtime.services, update ?? (async () => {
      throw new Error("Preparation sessions cannot admit evaluation attempts");
    }), context.onProgress);
    try {
      this.server = await startTransferReceiver({
        ...(receiver ? { receiver } : {}),
        token,
        key: await readFile(this.runtime.resolvePath(this.config.collector.keyFile)),
        cert: await readFile(this.runtime.resolvePath(this.config.collector.certFile)),
        host: this.config.collector.host,
        port: this.config.collector.port,
        control: (route, body) => this.control!.handle(route, body),
      });
      const config = context.safeConfig as unknown as EffectiveConfig;
      this.client = this.createClient({ environment: projectPortableSelection(config.environment, "environment", this.configTransport),
        pluginVersions: context.session.pluginVersions, packageDigest: this.packageDigest });
      await this.client.start(signal);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private createClient(imageGuard?: unknown): RayClient {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) => !Object.values(this.runtime.services).some(binding =>
          binding.auth.reference === name || binding.auth.value && value?.includes(binding.auth.value)),
      ),
    );
    return new RayClient({
      ...(imageGuard === undefined ? {} : { imageGuard }),
      pythonExecutable:
        this.config.pythonExecutable.includes("/") || this.config.pythonExecutable.includes("\\")
          ? this.runtime.resolvePath(this.config.pythonExecutable)
          : this.config.pythonExecutable,
      driverPath: fileURLToPath(new URL("../../../infrastructure/ray/python/driver.py", import.meta.url)),
      endpoint: this.config.endpoint,
      startupTimeoutMs: this.config.startupTimeoutMs,
      ...(this.config.concurrency === undefined ? {} : { concurrency: this.config.concurrency }),
      ...(this.config.nodes === undefined ? {} : { nodes: this.config.nodes }),
      env,
    });
  }
  async prepareTasks(jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation> {
    if (context.settings?.mode === "pipeline") throw new Error("Ray scheduler does not support pipeline preparation");
    if (context.settings?.lookahead !== undefined) throw new TypeError("Ray batch preparation does not accept lookahead");
    let placements: TaskPlacement[] = [];
    const tasks = await runPreparationRound(plan, context, signal, async (round, preparationSignal) => {
      placements = await this.prepareNodes(jobs, round, preparationSignal,
        context.settings?.concurrency ?? this.config.concurrency ?? this.client?.slots ?? 1, context.sensitiveValues,
        plan, context);
      for (const item of round.tasks ?? [])
        if (item.failure) (plan.preparationFailures ??= []).push({ taskId: item.taskId, failure: item.failure });
      const failed = new Set((plan.preparationFailures ?? []).map(item => item.taskId));
      return plan.tasks.filter(task => !failed.has(task.input.id));
    });
    return { tasks, placements };
  }
  private async prepareNodes(jobs: TaskJob[], round: PreparationRound, signal: AbortSignal, concurrency = 1,
    secrets: readonly string[], plan: BenchmarkRunPlan, preparationContext: PreparationContext): Promise<TaskPlacement[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("Preparation concurrency must be a positive integer");
    if (!this.client || !this.control || !this.preparationContext) throw new Error("Ray scheduler setup is required");
    const client = this.client, control = this.control, context = this.preparationContext;
    const timings = new Map(round.tasks?.map(task => [task.taskId, task]));
    assertRayCapacity(client.slots, this.config.concurrency, jobs.length);
    for (const job of jobs) this.prepared.delete(job.taskId);
    const nodes = [...client.nodes].sort();
    if (!nodes.length) throw new Error("No Ray execution nodes available for preparation");
    const assignments = new Map(nodes.map(node => [node, [] as TaskJob[]]));
    // Freeze placement before starting any work; distribute replicas by declared
    // attempt capacity rather than treating task CPU caps as reserved cores.
    for (const job of jobs) {
      const node = [...nodes].sort((a, b) =>
        assignments.get(a)!.length / client.nodeSlots[a]! - assignments.get(b)!.length / client.nodeSlots[b]! || a.localeCompare(b))[0]!;
      assignments.get(node)!.push(job);
    }
    for (const [nodeId, assigned] of assignments) context.onProgress?.({ phase: "prepare",
      message: `Ray node ${nodeId}: assigned ${assigned.length} tasks before image preparation` });
    const capacity = [...assignments].reduce((sum, [nodeId, assigned]) =>
      sum + Math.min(concurrency, assigned.length, client.nodeSlots[nodeId]!), 0);
    if (capacity > 1) { round.mode = "batch"; round.concurrency = capacity; }
    round.nodeConcurrency = Object.fromEntries([...assignments].filter(([, assigned]) => assigned.length)
      .map(([nodeId, assigned]) => [nodeId, preparationConcurrency(concurrency, assigned.length, client.nodeSlots[nodeId])]));
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const pendingKeys = new Set<AttemptKey>();
    const cancel = () => {
      for (const key of pendingKeys) {
        control.cancel(key);
        try { client.cancel(key.attemptId); } catch { /* Node heartbeat also cancels. */ }
      }
    };
    combined.addEventListener("abort", cancel, { once: true });
    try {
      const outcomes = await Promise.allSettled([...assignments].map(async ([nodeId, assigned]) => {
        const nodeConcurrency = preparationConcurrency(concurrency, assigned.length, client.nodeSlots[nodeId]);
        await runPreparationQueue(assigned, nodeConcurrency, combined, async job => {
          try {
            combined.throwIfAborted();
            const started = Date.now();
            const startedAt = new Date(started).toISOString();
            const preparationJob = { ...job, attemptId: randomUUID() };
            const key = { runId: job.runId, taskId: job.taskId, attemptId: preparationJob.attemptId };
            const timing = timings.get(job.taskId);
            if (!timing) throw new Error("Missing Ray preparation task timing");
            Object.assign(timing, { status: "preparing", startedAt, queueDurationMs: started - Date.parse(round.startedAt) });
            const preparation: RemotePreparation = { roundId: round.id, deadlineAt: round.deadlineAt, nodeId, mode: "prepare", digest: null,
              concurrency: nodeConcurrency, defaultTimeoutSeconds: plan.preparation.defaultTimeoutSeconds,
              environmentTimeoutSeconds: preparationContext.settings?.environmentTimeoutSeconds ?? null };
            const remote = validateRemoteJob({ ...projectRemoteJob({
      ...(this.runtime.network ? { network: networkSnapshot(this.runtime.network, this.runtime.benchmarkName ?? "unknown") } : {}),
              job: preparationJob, run: context.session, config: context.safeConfig as unknown as EffectiveConfig,
              packageDigest: this.packageDigest, uploadEndpoint: this.collectorUrl(), previousAttempts: [],
              ...(this.configTransport ? { configTransport: this.configTransport } : {}),
            }), schemaVersion: 2, preparation }, this.configTransport);
            control.register(key, this.packageDigest, context.session.pluginVersions, true);
            pendingKeys.add(key);
            try {
              const response = await client.submit(remote);
              const environmentTimeouts = response.type === "failed" ? response.environmentTimeouts : response.type === "prepared" ? response.result.environmentTimeouts : undefined;
              if (environmentTimeouts) timing.environmentTimeouts = environmentTimeouts;
              combined.throwIfAborted();
              if (response.type === "failed" && response.retired !== true)
                throw new EvaluatorError("CLEANUP_FAILED", "Remote preparation retirement is unconfirmed");
              if (response.type === "failed" && isErrorCode(response.code))
                throw new EvaluatorError(response.code, `Ray environment preparation failed for ${job.taskId} (${response.code})`,
                  { component: "environment", operation: "ray-prepare", ...(response.network ?? {}) });
              if (response.type !== "prepared" || response.result.nodeId !== nodeId)
                throw new Error(`Ray environment preparation failed for ${job.taskId}`);
              control.finishProgress(key, "completed");
              for (const warning of response.result.warnings ?? []) context.log?.(`[warn] [environment] ${job.taskId}: ${warning}`);
              this.prepared.set(job.taskId, { ...preparation, mode: "execute", digest: response.result.preparationDigest });
              Object.assign(timing, { status: "ready", finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
            } catch (error) {
              control.finishProgress(key, combined.aborted ? "cancelled" : "failed");
              if (combined.aborted) throw error;
              const now = new Date().toISOString();
              const failure = classifyError(error, { phase: "prepare", component: "environment", secrets });
              Object.assign(timing, { status: "error", finishedAt: now, durationMs: Date.now() - started, failure });
              if (["abort_run", "stop_dispatch"].includes(failureDecision(failure).action)) throw error;
              if (preparationContext.onError !== "continue") throw error;
            } finally { pendingKeys.delete(key); }
          } catch (error) { controller.abort(error); throw error; }
        });
      }));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      combined.throwIfAborted();

      round.placements = jobs.filter(job => this.prepared.has(job.taskId)).map(job => {
        const receipt = this.prepared.get(job.taskId)!;
        return { taskId: job.taskId, nodeId: receipt.nodeId, digest: receipt.digest! };
      });
      return [...assignments].flatMap(([nodeId, assigned]) => assigned.map(job => ({ taskId: job.taskId, nodeId })));
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally { combined.removeEventListener("abort", cancel); }
  }
  private async collected(key: AttemptKey, response?: RayResult): Promise<AttemptRecord | null> {
    const snapshot = await this.context!.store.snapshot();
    const remote = snapshot.run.remoteAttempts?.find(
      item => item.key.attemptId === key.attemptId && item.key.taskId === key.taskId,
    );
    const record = snapshot.records.find(
      item => item.key.attemptId === key.attemptId && item.key.taskId === key.taskId,
    );
    if (remote?.state !== "collected" || !remote.receipt || !record) return null;
    if (response?.type === "result") {
      const receipt = response.result?.receipt;
      if (
        !receipt ||
        !receipt.accepted ||
        receipt.schemaVersion !== 1 ||
        receipt.receipt !== remote.receipt ||
        receipt.transferId !== remote.transferId ||
        receipt.key?.runId !== key.runId ||
        receipt.key?.taskId !== key.taskId ||
        receipt.key?.attemptId !== key.attemptId
      )
        throw Object.assign(new Error("Ray result lacks a matching accepted receipt"), { code: "RAY_PROTOCOL_INVALID" });
    }
    return record;
  }
  private async executeOne(job: TaskJob, signal: AbortSignal, timeoutSeconds: number): Promise<AttemptRecord | null> {
    const context = this.context!,
      client = this.client!,
      control = this.control!;
    const key = { runId: job.runId, taskId: job.taskId, attemptId: job.attemptId };
    const config = context.safeConfig as unknown as EffectiveConfig;
    const projected = projectRemoteJob({
      ...(this.runtime.network ? { network: networkSnapshot(this.runtime.network, this.runtime.benchmarkName ?? "unknown") } : {}),
      job,
      run: context.run,
      config: { ...config, run: { ...config.run, timeoutSeconds } },
      packageDigest: this.packageDigest,
      uploadEndpoint: this.collectorUrl(),
      previousAttempts: this.previous.filter(item => item.key.taskId === job.taskId).map(item => item.key),
      ...(this.configTransport ? { configTransport: this.configTransport } : {}),
    });
    const preparation = this.prepared.get(job.taskId);
    if (context.run.executionVersion === 2 && !preparation) throw new Error("Ray task has not passed the preparation barrier");
    const remote = preparation ? validateRemoteJob({ ...projected, schemaVersion: 2, preparation }, this.configTransport) : projected;
    const startedAt = new Date().toISOString();
    const paths = await context.store.allocate(key);
    control.register(key, this.packageDigest, context.run.pluginVersions);
    await context.store.updateRemoteAttempt!({ key, state: "queued" });
    let result: RayResult | undefined;
    let progressOutcome: "completed" | "failed" = "failed";
    let failure: unknown;
    let finished = false;
    const pending = client.submit(remote).then(
      value => {
        result = value;
        finished = true;
      },
      error => {
        failure = error;
        finished = true;
      },
    );
    let cancelAt: number | null = null;
    let forceAt: number | null = null;
    let retained: AttemptRecord | null = null;
    let infrastructureTimeout = false;
    const cancel = () => {
      if (cancelAt !== null) return;
      cancelAt = Date.now();
      control.cancel(key, infrastructureTimeout);
      try {
        client.cancel(key.attemptId);
      } catch {
        /* Lost bridge: node heartbeat independently cancels. */
      }
    };
    const overallDeadline =
      Date.now() + remote.safeConfig.timeoutSeconds * 1000 + this.config.startupTimeoutMs + 300000;
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      while (!finished) {
        if (cancelAt !== null && retained === null) retained = await this.collected(key);
        if (Date.now() - control.lastSeen(key) > this.config.heartbeatTimeoutMs || Date.now() > overallDeadline) {
          infrastructureTimeout = !signal.aborted;
          cancel();
        }
        if (
          cancelAt !== null &&
          retained === null &&
          forceAt === null &&
          Date.now() - cancelAt > this.config.cancelGraceMs
        ) {
          forceAt = Date.now();
          try {
            client.cancel(key.attemptId, true);
          } catch {
            /* A failed bridge rejects pending requests; otherwise the retirement timeout closes it. */
          }
        }
        const retirementAt = forceAt ?? (retained === null ? null : cancelAt);
        if (retirementAt !== null && Date.now() - retirementAt > this.config.startupTimeoutMs)
          throw new Error("Ray bridge did not acknowledge cancelled attempt retirement");
        await Promise.race([pending, delay(200)]);
      }
      const record = (await this.collected(key, result)) ?? retained;
      if (result?.type === "result")
        for (const warning of result.result.warnings ?? []) context.log?.(`[warn] [environment] ${job.taskId}: ${warning}`);
      if (record) { progressOutcome = record.executionStatus === "completed" ? "completed" : "failed"; return record; }
      await context.store.updateRemoteAttempt!({
        key,
        state: "uncollected",
        message: signal.aborted
          ? "Cancelled before confirmed collection; node evidence retained"
          : failure
            ? "Ray bridge disconnected; node evidence retained"
            : result?.type === "failed"
              ? `Ray worker failed (${result.code}); node evidence retained`
              : "No confirmed upload receipt; inspect node evidence",
      });
      if (!signal.aborted) {
        const message = result?.type === "failed" ? `Ray worker failed (${result.code}); retained node evidence has no accepted receipt`
          : "Ray attempt has no confirmed collection; retained node evidence is unscored";
        const errors: Failure[] = [classifyError(Object.assign(new Error(message), {
          details: result?.type === "failed" ? { ...result.network, ...(result.originalName ? { originalName: result.originalName } : {}) } : undefined,
          code: infrastructureTimeout ? "RAY_HEARTBEAT_TIMEOUT" : result?.type === "failed" ? result.code
            : result?.type === "result" ? "RAY_RESULT_UNCOLLECTED" : "RAY_WORKER_LOST",
        }), { phase: "environment", component: "scheduler", fallbackCode: "RAY_WORKER_LOST" })];
        // A lost or forcibly killed Ray worker may leave an orphan Node process.
        // Its exit must be acknowledged before container cleanup permits retries.
        if (forceAt !== null || !(result?.type === "result" || (result?.type === "failed" && result.retired === true)))
          errors.push(classifyError(Object.assign(new Error("Ray node process retirement is unconfirmed; refusing overlapping retries"), { code: "CLEANUP_TIMEOUT" }), { phase: "cleanup" }));
        else try { await client.cleanupAttempt(key, AbortSignal.timeout(185_000)); }
        catch (error) { errors.push(classifyError(Object.assign(new Error(formatError(error)), { code: "CLEANUP_TIMEOUT" }), { phase: "cleanup" })); }
        return await saveInvalidAttempt(context.store, key, paths, startedAt, errors, context.run.evaluationKind);
      }
      return null;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "RAY_PROTOCOL_INVALID") throw error;
      cancel();
      const record = await this.collected(key);
      if (record) { progressOutcome = record.executionStatus === "completed" ? "completed" : "failed"; return record; }
      await context.store.updateRemoteAttempt!({ key, state: "uncollected", message: "Ray execution retirement unconfirmed; node evidence retained" });
      if (signal.aborted) return null;
      return await saveInvalidAttempt(context.store, key, paths, startedAt, [
        classifyError(error, { phase: "environment", cancellation: "infrastructure" }),
        classifyError(Object.assign(new Error("Ray bridge did not confirm retirement; queued dispatch stopped"), { code: "CLEANUP_TIMEOUT" }), { phase: "cleanup" }),
      ], context.run.evaluationKind);
    } finally {
      control.finishProgress(key, signal.aborted ? "cancelled" : progressOutcome);
      signal.removeEventListener("abort", cancel);
    }
  }
  /** Sweep run containers leaked by interrupted attempts from every live node. */
  async recoverAttempts(attempts: AttemptKey[], signal: AbortSignal): Promise<void> {
    if (!this.client) throw new Error("Ray scheduler setup is required");
    await this.client.cleanup(this.context!.run.runId, signal);
  }

  validateCapacity(taskCount: number): void {
    if (!this.client) throw new Error("Ray scheduler setup is required");
    assertRayCapacity(this.client.slots, this.config.concurrency, taskCount);
  }
  async *executeReady(jobs: AsyncIterable<TaskJob>, executor: TaskExecutor, signal: AbortSignal): AsyncIterable<AttemptRecord> {
    if (!this.context || !this.client || !this.control || !this.server) throw new Error("Ray scheduler setup is required");
    const slots = Math.max(this.client.slots, 1);
    const limit = this.config.concurrency === undefined ? slots : Math.min(this.config.concurrency, slots);
    this.client.limit = limit;
    const scheduler = new LocalScheduler(limit);
    const remote: TaskExecutor = async (job, taskSignal) => {
      if (job.preparationFailure) return executor(job, taskSignal);
      const result = await this.executeOne(job, taskSignal, (this.context!.safeConfig as unknown as EffectiveConfig).run.timeoutSeconds);
      if (!result) throw new EvaluatorError("RAY_RESULT_UNCOLLECTED", "Remote execution produced no admitted result");
      return result;
    };
    try { yield* scheduler.executeReady(jobs, remote, signal); } finally { await this.close(); }
  }
  async close(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      try { await this.server?.close(); }
      finally { this.control?.close(); this.server = undefined; }
    }
  }
  private collectorUrl(): string {
    if (!this.config.collector.publicUrl) return this.server!.url;
    const url = new URL(this.config.collector.publicUrl);
    if (this.config.collector.port === 0) url.port = new URL(this.server!.url).port;
    return url.origin;
  }
}

export function assertRayCapacity(slots: number, concurrency: number | undefined, taskCount: number): void {
  const required = Math.min(concurrency ?? slots, taskCount);
  if (slots < required) throw new Error(`Ray selected nodes provide ${slots} task slots; ${required} required for ${taskCount} pending tasks`);
}
