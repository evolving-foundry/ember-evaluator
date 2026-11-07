import { registerGatewayRun } from "../../infrastructure/filesystem/run-index.js";
import { validateNetworkSnapshot } from "../../config/network-schema.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JsonValue } from "../../core/contracts/task.js";
import type { PluginFactoryContext } from "../../core/contracts/plugin.js";
import { JobsClient } from "../../infrastructure/ray/jobs-client.js";
import { type JobsConfig } from "../../config/jobs.js";
import { ensureManagedLocalCluster, resolveManagedLocalBundlePath } from "./managed-local.js";
import { buildResumeSeed, downloadRunResults, localizeRunPluginRuntime } from "./jobs-results.js";
import { expectRecord, expectNonEmptyString, parseSelection } from "../../core/validation/input.js";
import { projectPortableSelection } from "../../infrastructure/ray/protocol.js";
import type { ConfigTransportLookup } from "../../core/contracts/config-transport.js";
import { resolveResumeRun } from "../../core/recovery/resume.js";
import { ResumeError } from "../../core/recovery/resume-error.js";
import { rebuildReport } from "../report/index.js";
import type { ProgressListener } from "../../core/progress/progress.js";
import type { WarmupSummary } from "../warmup.js";
import { parseWarmupSummary } from "./warmup-result.js";

export type JobsSubmitOptions = { signal: AbortSignal; resume?: string | null; log(text: string): void; onProgress?: ProgressListener };

export type JobsExperimentResult = {
  exitCode: number;
  jobId: string;
  runId: string | null;
  runDirectory: string | null;
  reportPath: string | null;
  collectionError: string | null;
  reportError: string | null;
};

type Receipt = { jobId: string; endpoint: string; createdAt: string; runId?: string };
type ReceiptState = Receipt & { status: string | null };

const alive = (status: string | null) => status === "PENDING" || status === "RUNNING";

export async function rebuildDownloadedReport(
  destination: string,
  runtime: Pick<PluginFactoryContext, "configDirectory" | "pluginPatchPath">,
): Promise<void> {
  await localizeRunPluginRuntime(destination, runtime.configDirectory, runtime.pluginPatchPath);
  await rebuildReport(destination);
}

export class RayJobsDeployment {
  constructor(
    private readonly config: JobsConfig,
    private readonly runtime: PluginFactoryContext,
    private readonly configTransport?: ConfigTransportLookup,
  ) {}

  private receiptsDirectory(outputRoot: string): string {
    return join(outputRoot, ".jobs");
  }

  private async readReceipts(outputRoot: string): Promise<Receipt[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.receiptsDirectory(outputRoot));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const receipts: Receipt[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const receipt = expectRecord(
          JSON.parse(await readFile(join(this.receiptsDirectory(outputRoot), name), "utf8")),
          "job receipt",
        );
        if (receipt.endpoint !== this.config.endpoint) continue;
        const jobId = expectNonEmptyString(receipt.jobId, "job receipt jobId");
        if (!/^[0-9a-f-]{36}$/u.test(jobId)) continue;
        receipts.push({
          jobId,
          endpoint: this.config.endpoint,
          createdAt: String(receipt.createdAt ?? ""),
          ...(typeof receipt.runId === "string" && /^[0-9a-f-]{36}$/u.test(receipt.runId)
            ? { runId: receipt.runId }
            : {}),
        });
      } catch {
        /* A truncated receipt is diagnostics, never a submission blocker. */
      }
    }
    return receipts;
  }

  private async liveJobs(client: JobsClient, outputRoot: string, signal: AbortSignal): Promise<ReceiptState[]> {
    const receipts = await this.readReceipts(outputRoot);
    return (
      await Promise.all(
        receipts.map(async receipt => {
          try {
            const state = expectRecord(await client.call(`/jobs/${receipt.jobId}`, undefined, signal), "job status");
            return { ...receipt, status: String(state.status) };
          } catch {
            /* Unreachable gateway or expired job: not a live coordinator. */ return { ...receipt, status: null };
          }
        }),
      )
    ).filter(state => alive(state.status));
  }

  /** Follow a job to its terminal state, cancel it on abort, then collect results. */
  private async follow(
    client: JobsClient,
    jobId: string,
    outputRoot: string,
    runId: string | null,
    options: JobsSubmitOptions,
  ): Promise<JobsExperimentResult> {
    let code: number;
    try {
      code = options.onProgress ? await client.attach(jobId, options.log, options.signal, options.onProgress)
        : await client.attach(jobId, options.log, options.signal);
    } catch (error) {
      if (!options.signal.aborted) throw error;
      code = 130;
    }
    let collectionSignal = options.signal;
    if (options.signal.aborted) {
      // Cancellation is asynchronous. Retain partial evidence before returning so
      // --resume can seed the cancelled run instead of losing its run identity.
      collectionSignal = AbortSignal.timeout(210_000);
      try {
        await client.call(`/jobs/${jobId}/cancel`, {}, collectionSignal);
        options.log("Cluster job cancellation requested; waiting for partial results to be saved.");
        if (options.onProgress) await client.attach(jobId, options.log, collectionSignal, options.onProgress);
        else await client.attach(jobId, options.log, collectionSignal);
      } catch (error) {
        options.log(`Results have not been collected after cancellation: ${error instanceof Error ? error.message : String(error)}; keeping the receipt for job ${jobId}.`);
        return { exitCode: 130, jobId, runId, runDirectory: null, reportPath: null,
          collectionError: error instanceof Error ? error.message : String(error), reportError: null };
      }
      code = 130;
    }
    let destination: string | null = null;
    let collectionError: string | null = null;
    let reportError: string | null = null;
    let reportPath: string | null = null;
    try {
      destination = await downloadRunResults(client, jobId, outputRoot, options.log, collectionSignal);
    } catch (error) {
      collectionError = error instanceof Error ? error.message : String(error);
      options.log(`Result download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (destination !== null) {
      if (runId !== basename(destination)) await this.backfillReceipt(outputRoot, jobId, basename(destination));
      try {
        await rebuildDownloadedReport(destination, this.runtime);
        reportPath = join(destination, "report.md");
        options.log(join(destination, "report.md"));
      } catch (error) {
        reportError = error instanceof Error ? error.message : String(error);
        options.log(`Report generation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { exitCode: code, jobId, runId: destination === null ? runId : basename(destination),
      runDirectory: destination, reportPath, collectionError, reportError };
  }

  private async backfillReceipt(outputRoot: string, jobId: string, runId: string): Promise<void> {
    const path = join(this.receiptsDirectory(outputRoot), `${jobId}.json`);
    try {
      const receipt = expectRecord(JSON.parse(await readFile(path, "utf8")), "job receipt") as Receipt;
      if (receipt.runId === runId) return;
      await writeFile(path, JSON.stringify({ ...receipt, runId }) + "\n");
    } catch {
      /* Receipt bookkeeping is best effort. */
    }
  }

  async submitExperiment(
    config: JsonValue,
    pluginVersions: Record<string, string>,
    options: JobsSubmitOptions,
  ): Promise<number> {
    return (await this.runExperiment(config, pluginVersions, options)).exitCode;
  }

  async runExperiment(
    config: JsonValue,
    pluginVersions: Record<string, string>,
    options: JobsSubmitOptions,
  ): Promise<JobsExperimentResult> {
    await this.ensureCluster(config, options);
    const client = await JobsClient.create(this.config, this.runtime.resolvePath, Object.values(this.runtime.services).map(binding => binding.auth.value));
    const outputRoot = expectNonEmptyString(
      expectRecord(expectRecord(config, "experiment").output, "output").directory,
      "output directory",
    );
    const live = await this.liveJobs(client, outputRoot, options.signal);
    let resumeDirectory: string | undefined;
    if (options.resume !== undefined) {
      try {
        resumeDirectory = await resolveResumeRun(outputRoot, options.resume);
      } catch (error) {
        // A run that never reached a terminal download can still be followed live.
        if (error instanceof ResumeError && error.code === "CONFIG_INVALID" && live.length === 1) {
          return await this.follow(client, live[0]!.jobId, outputRoot, live[0]!.runId ?? null, options);
        }
        throw error;
      }
      const runId = basename(resumeDirectory);
      const matching = live.filter(state => state.runId === runId);
      if (matching.length) {
        options.log(`Resuming run ${runId}...`);
        return await this.follow(client, matching[0]!.jobId, outputRoot, runId, options);
      }
    }
    if (live.length)
      throw new Error(`A cluster evaluation job is already running (job ${live[0]!.jobId}); wait for it to finish or use --resume to follow or resume it`);
    const portable = this.portableConfig(config);
    const seed = resumeDirectory === undefined ? null : await buildResumeSeed(resumeDirectory);
    const id = randomUUID();
    const requestedRunId = seed?.runId ?? randomUUID();
    await mkdir(this.receiptsDirectory(outputRoot), { recursive: true });
    const receipt: Receipt = {
      jobId: id,
      endpoint: this.config.endpoint,
      createdAt: new Date().toISOString(),
      runId: requestedRunId,
    };
    // Publish identity before the request: an interrupted acknowledgement must not cause blind resubmission.
    await writeFile(join(this.receiptsDirectory(outputRoot), `${id}.json`), JSON.stringify(receipt) + "\n", {
      flag: "wx",
    });
    const { transport: _transport, concurrency: _concurrency, nodes: _nodes, ...connection } = this.config;
    const saved = structuredClone(expectRecord(config, "experiment"));
    for (const role of ["benchmark", "environment", "solver", "verifier", "store", "reporter"] as const) {
      if (saved[role] === undefined) continue;
      const selection = expectRecord(saved[role], role);
      const name = expectNonEmptyString(selection.name, `${role}.name`);
      const settings = expectRecord(selection.config, `${role}.config`);
      for (const field of this.configTransport?.(role, name)?.secretFields ?? []) delete settings[field];
    }
    saved.deployment = { kind: "ray-jobs", ...connection };
    const savedServices = expectRecord(saved.services, "services");
    for (const [name, binding] of Object.entries(this.runtime.services)) {
      const service = expectRecord(savedServices[name], `services.${name}`);
      delete service.apiKeyEnv;
      service.apiKey = binding.auth.reference ? `\${${binding.auth.reference}}` : "[runtime-provided]";
    }
    const retryConfig = join(this.receiptsDirectory(outputRoot), `${id}-retry.yaml`);
    await writeFile(retryConfig, JSON.stringify(saved), { mode: 0o600, flag: "wx" });
    await registerGatewayRun(requestedRunId, retryConfig, id, this.runtime.configDirectory, this.runtime.pluginPatchPath);
    options.log(seed ? `Resuming run ${seed.runId}; cluster evaluation job submitted` : "Cluster evaluation job submitted");
    await client.call(
      `/jobs/${id}/submit`,
      {
        config: portable,
        requestedRunId,
        pluginVersions,
        serviceAuth: Object.fromEntries(Object.entries(this.runtime.services).map(([name, binding]) => [name, binding.auth.value])),
        ...(seed ? { seed: seed.seed, resumeRunId: seed.runId } : {}),
      },
      options.signal,
    );
    return await this.follow(client, id, outputRoot, requestedRunId, options);
  }

  private async ensureCluster(config: JsonValue, options: Pick<JobsSubmitOptions, "signal" | "log">): Promise<void> {
    if (this.config.managedLocal !== true) return;
    const solver = expectRecord(expectRecord(config, "experiment").solver, "solver");
    const bundlePath = solver.name === "agentbundle"
      ? resolveManagedLocalBundlePath(this.runtime.configDirectory,
        expectNonEmptyString(expectRecord(solver.config, "solver config").path, "agentbundle.path")) : undefined;
    await ensureManagedLocalCluster(options.signal, options.log, bundlePath);
  }

  private portableConfig(config: JsonValue): Record<string, unknown> {
    const portable = structuredClone(expectRecord(config, "experiment"));
    if (portable.network !== undefined) validateNetworkSnapshot(portable.network);
    for (const role of ["benchmark", "environment", "solver", "verifier", "store", "reporter"] as const) {
      if (role === "verifier" && portable[role] === undefined) continue;
      const selection = expectRecord(portable[role], role);
      portable[role] = projectPortableSelection({ ...selection,
        ...parseSelection({ name: selection.name, config: selection.config }, role) }, role, this.configTransport);
    }
    if (Array.isArray(portable.metrics)) portable.metrics = portable.metrics.map(item =>
      projectPortableSelection(parseSelection(item, "metrics"), "metrics", this.configTransport));
    portable.output = { directory: "results" };
    portable.scheduler = { name: "ray", config: {
      ...(this.config.concurrency === undefined ? {} : { concurrency: this.config.concurrency }),
      ...(this.config.nodes === undefined ? {} : { nodes: this.config.nodes }) } };
    return portable;
  }

  async warmupExperiment(config: JsonValue, pluginVersions: Record<string, string>,
    options: Omit<JobsSubmitOptions, "resume">): Promise<WarmupSummary> {
    await this.ensureCluster(config, options);
    const client = await JobsClient.create(this.config, this.runtime.resolvePath);
    const portable = this.portableConfig(config);
    const services = expectRecord(portable.services, "services");
    for (const service of Object.values(services)) {
      const model = expectRecord(service, "service");
      delete model.apiKey; delete model.apiKeyEnv;
    }
    const id = randomUUID();
    options.log(`Cluster image warmup job ${id}: submitting preparation only`);
    try {
      await client.call(`/jobs/${id}/submit`, { operation: "warmup", config: portable,
        pluginVersions, serviceAuth: {} }, options.signal);
      const code = await client.attach(id, options.log, options.signal, options.onProgress);
      options.signal.throwIfAborted();
      const summary = parseWarmupSummary(await client.call(`/jobs/${id}/warmup`, undefined, options.signal));
      if (code !== 0 && summary.status === "ready") throw new Error(`Warmup job ${id} failed despite a ready summary`);
      return summary;
    } catch (error) {
      // The gateway admits by ID, so an interrupted acknowledgement cannot cause a second job.
      try {
        const cleanupSignal = AbortSignal.timeout(90_000);
        await client.call(`/jobs/${id}/cancel`, {}, cleanupSignal);
        await client.attach(id, text => { try { options.log(text); } catch { /* Cleanup must survive a presentation failure. */ } }, cleanupSignal);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Warmup job ${id} termination was not confirmed`);
      }
      throw error;
    }
  }

  async cleanupImages(config: JsonValue, pluginVersions: Record<string, string>,
    request: import("../../core/contracts/image-cleanup.js").ImageCleanupRequest,
    options: Omit<JobsSubmitOptions, "resume">): Promise<import("../../core/contracts/image-cleanup.js").ImageCleanupSummary> {
    // Maintenance must not build, start, or recreate a managed cluster.
    const client = await JobsClient.create(this.config, this.runtime.resolvePath);
    const portable = this.portableConfig(config);
    const services = expectRecord(portable.services, "services");
    for (const raw of Object.values(services)) {
      const service = expectRecord(raw, "service");
      delete service.apiKey; delete service.apiKeyEnv;
    }
    const id = randomUUID();
    try {
      await client.call(`/jobs/${id}/submit`, { operation: "cleanup-images", config: portable,
        pluginVersions, serviceAuth: {}, cleanup: { all: request.all, execute: request.execute } }, options.signal);
      const code = await client.attach(id, options.log, options.signal);
      const { parseImageCleanupSummary } = await import("../../infrastructure/ray/image-cleanup.js");
      const summary = parseImageCleanupSummary(await client.call(`/jobs/${id}/image-cleanup`, undefined, options.signal));
      if (summary.preview === request.execute) throw new Error("Image cleanup result differs from requested mode");
      if (code !== 0 && !summary.nodes.some(node => node.error || node.items.some(item => item.status === "failed"))) throw new Error("Image cleanup job failed without failure diagnostics");
      return summary;
    } catch (error) {
      const cleanupSignal = AbortSignal.timeout(90_000);
      try {
        await client.call(`/jobs/${id}/cancel`, {}, cleanupSignal);
        await client.attach(id, () => {}, cleanupSignal);
      } catch (cause) { throw new AggregateError([error, cause], `Image cleanup job ${id} termination was not confirmed`); }
      if (options.signal.aborted) {
        try {
          const { parseImageCleanupSummary } = await import("../../infrastructure/ray/image-cleanup.js");
          return parseImageCleanupSummary(await client.call(`/jobs/${id}/image-cleanup`, undefined, cleanupSignal));
        } catch { /* A coordinator killed before publication has no confirmed partial summary. */ }
      }
      throw error;
    }
  }

  async retryExperiment(runId: string, jobId: string, options: { taskIds: string[]; requestId?: string; reason?: string; pluginVersions: Record<string, string>; signal: AbortSignal; log(text: string): void; onProgress?: ProgressListener }): Promise<number> {
    const client = await JobsClient.create(this.config, this.runtime.resolvePath, Object.values(this.runtime.services).map(binding => binding.auth.value));
    const requestId = options.requestId ?? randomUUID();
    let receipt: unknown;
    try {
      receipt = await client.call(`/jobs/${jobId}/retry`, { runId, taskIds: options.taskIds,
        requestId, reason: options.reason, pluginVersions: options.pluginVersions,
        serviceAuth: Object.fromEntries(Object.entries(this.runtime.services).map(([name, binding]) => [name, binding.auth.value])) }, options.signal);
    } catch (error) {
      throw new Error(`Retry request ${requestId} was not confirmed. Resubmit the same request ID; do not generate a new ID.`, { cause: error });
    }
    const response = expectRecord(receipt, "retry receipt");
    options.log(`Run ${runId}: ${String(response.status)}; request=${String(response.requestId)}`);
    if (typeof response.recoveryJobId === "string") return options.onProgress
      ? await client.attach(response.recoveryJobId, options.log, options.signal, options.onProgress, jobId)
      : await client.attach(response.recoveryJobId, options.log, options.signal);
    return 0;
  }

}
