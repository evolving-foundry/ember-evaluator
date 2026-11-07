import { LocalRecordSource } from "../../../../infrastructure/datasets/sources/local/files-source.js";
import { localDatasetConfig } from "../../shared/local-data.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../../core/validation/input.js";
import { type EffectiveConfig } from "../../../../core/contracts/config.js";
import type { Benchmark, BenchmarkRunPlan } from "../../../../core/contracts/benchmark.js";
import type { PreparedTask, SourceLock, TaskRef } from "../../../../core/contracts/task.js";
import type { SolveResult, VerifyResult } from "../../../../core/contracts/result.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import { DatasetCache } from "../../../../infrastructure/datasets/cache.js";
import type { DatasetRecordSource } from "../../../../infrastructure/datasets/record-source.js";
import type { ActivityListener } from "../../../../core/contracts/activity.js";
import { withDatasetActivity } from "../../../../infrastructure/datasets/activity.js";
import { HuggingFaceFilesSource } from "../../../../infrastructure/datasets/sources/huggingface/files-source.js";
import { agentXAssets, agentXBridgeDigest } from "../../../../runtimes/agentx/runtime.js";
import { parseAgentXSummary, type AgentXMode, type AgentXVariant, type AgentXWorkload } from "./evidence/summary.js";
import { parseTelemetryConfig } from "./evidence/telemetry.js";

export type AgentXConfig = {
  variant: AgentXVariant;
  mode: Exclude<AgentXMode, "smoke">;
  concurrency: number[];
  durationSeconds: number;
  seed: number;
  traceCount?: number;
  cacheDir: string;
  hfToken?: string;
  localPath?: string;
};

export function parseAgentXConfig(value: unknown): AgentXConfig {
  const v = expectRecord(value, "agentx");
  rejectUnknown(v, ["variant", "mode", "concurrency", "durationSeconds", "seed", "traceCount", "cacheDir", "hfToken", "localPath"], "agentx");
  if (v.variant !== undefined && v.variant !== "256k" && v.variant !== "full") throw new TypeError("agentx.variant must be 256k or full");
  if (v.mode !== undefined && !["standard", "replay"].includes(String(v.mode))) throw new TypeError("agentx.mode must be standard or replay");
  const mode = v.mode === "replay" ? "replay" : "standard";
  const entries = v.concurrency ?? [1];
  if (!Array.isArray(entries) || !entries.length) throw new TypeError("agentx.concurrency must be a non-empty array");
  const concurrency = entries.map(n => expectPositiveInteger(n, "agentx.concurrency"));
  if (new Set(concurrency).size !== concurrency.length) throw new TypeError("agentx.concurrency must not contain duplicates");
  const durationSeconds = expectPositiveInteger(v.durationSeconds ?? (mode === "replay" ? 86400 : 3600), "agentx.durationSeconds");
  const seed = v.seed ?? 42;
  if (!Number.isSafeInteger(seed)) throw new TypeError("agentx.seed must be a safe integer");
  if (mode === "standard" && seed !== 42) throw new TypeError("AgentX standard requires seed=42");
  const traceCount = mode === "replay" ? expectPositiveInteger(v.traceCount, "agentx.traceCount") : undefined;
  if (mode !== "replay" && v.traceCount !== undefined) throw new TypeError("agentx.traceCount requires mode=replay");
  if (traceCount !== undefined && concurrency.some(n => n > traceCount)) throw new TypeError("AgentX replay concurrency must not exceed traceCount");
  return { ...localDatasetConfig(v), variant: v.variant === "full" ? "full" : "256k", mode, concurrency, durationSeconds, seed: Number(seed),
    ...(traceCount === undefined ? {} : { traceCount }),
    cacheDir: expectNonEmptyString(v.cacheDir ?? ".cache/agentx", "agentx.cacheDir"),
    ...(v.hfToken === undefined ? {} : { hfToken: expectNonEmptyString(v.hfToken, "agentx.hfToken") }) };
}

export class AgentXBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  private readonly source: DatasetRecordSource;
  private readonly cache: DatasetCache;
  private readonly dataset: string;
  constructor(readonly config: AgentXConfig, private readonly environmentName: string, source?: DatasetRecordSource, network?: import("../../../../core/contracts/network.js").NetworkAccess) {
    this.dataset = `semianalysisai/cc-traces-weka-062126${config.variant === "256k" ? "-256k" : ""}`;
    this.cache = new DatasetCache(config.cacheDir, network);
    const definition = { dataset: this.dataset, revision: "main",
      selections: [{ key: "traces", format: "jsonl" as const, path: "traces.jsonl" }] };
    this.source = source ?? (config.localPath === undefined
      ? new HuggingFaceFilesSource(config.cacheDir, "agentx", definition, config.hfToken ?? process.env.HF_TOKEN, undefined, network)
      : new LocalRecordSource(config.localPath, definition));
  }

  validateRun(config: EffectiveConfig): void {
    if (config.solver.name !== "agentx-replay" || config.verifier !== undefined)
      throw new TypeError("AgentX requires agentx-replay and has no correctness verifier");
    if (!["local", "docker"].includes(config.environment.name) || config.scheduler.name !== "local" ||
      config.scheduler.config.concurrency !== 1) throw new TypeError("AgentX supports local/Docker with local scheduler concurrency=1");
    if (config.solver.config.telemetry !== undefined) {
      const ascend = parseTelemetryConfig(config.solver.config.telemetry, config.hardware).ascend;
      if (ascend && "mode" in ascend && !["local", "docker"].includes(config.environment.name))
        throw new TypeError("Local Ascend telemetry requires a local Docker host or local environment");
    }
    const minimum = this.config.durationSeconds + 3600 + 300;
    if (config.run.timeoutSeconds < minimum) throw new TypeError(`AgentX run.timeoutSeconds must be at least ${minimum} (includes configuration, warmup and drain)`);
    if (config.run.preparation?.mode === "pipeline") throw new TypeError("AgentX does not support pipeline preparation");
    const model = config.services[config.solver.service];
    if (!model || model.api !== "openai-completions" || model.endpoint === null)
      throw new TypeError("AgentX requires an OpenAI Chat Completions endpoint");
    if (model.maxTokens !== undefined) throw new TypeError("AgentX output lengths come from traces; remove services maxTokens");
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock> {
    return await withDatasetActivity(activity, () => this.source.resolve(previous, signal));
  }

  async *enumerate(_source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const concurrency of this.config.concurrency) {
      signal.throwIfAborted();
      yield { id: this.id(concurrency), recordKey: { concurrency } };
    }
  }

  private id(concurrency: number): string { return `agentx-${this.config.variant}-${this.config.mode}-c${concurrency}`; }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    const key = expectRecord(ref.recordKey, "AgentX task key");
    const concurrency = expectPositiveInteger(key.concurrency, "AgentX task concurrency");
    if (!this.config.concurrency.includes(concurrency) || ref.id !== this.id(concurrency)) throw new TypeError("Invalid AgentX point selection");
    const file = source.files.find(file => file.path === "traces.jsonl");
    const metadata = expectRecord(source.metadata, "AgentX source metadata");
    if (!file || source.files.length !== 1 || metadata.dataset !== this.dataset || !/^(?:[a-f0-9]{40}|local:[a-f0-9]{64})$/u.test(source.revision))
      throw new TypeError("Invalid locked AgentX corpus");
    const token = this.config.hfToken ?? process.env.HF_TOKEN;
    const tracePath = this.source instanceof LocalRecordSource
      ? await this.source.files.file(source, "traces.jsonl", signal)
      : (await this.cache.fetch(file.origin, file.sha256, signal, token ? { Authorization: `Bearer ${token}` } : undefined)).path;
    const payload: AgentXWorkload = { schemaVersion: 1, kind: "agentx", variant: this.config.variant, mode: this.config.mode,
      concurrency, durationSeconds: this.config.durationSeconds, seed: this.config.seed, dataset: this.dataset,
      loader: `semianalysis_cc_traces_weka_062126${this.config.variant === "256k" ? "_256k" : ""}`,
      revision: source.revision, sha256: file.sha256, tracePath: "input/traces.jsonl",
      ...(this.config.traceCount === undefined ? {} : { traceCount: this.config.traceCount }) };
    return { input: { id: ref.id, prompt: `AgentX ${this.config.variant} ${this.config.mode}: ${concurrency} concurrent session trees`, payload },
      verification: payload, solveEnv: { workdir: ".", image: null, initialFiles: [{ source: tracePath, target: payload.tracePath }],
        runtime: [], ...(this.environmentName === "docker" ? { network: "host", build: { context: agentXAssets,
          dockerfile: "Dockerfile", sourceHash: await agentXBridgeDigest(signal) } } : {}) },
      verifyEnv: null, transfer: null, verificationMode: "none",
      artifactCollection: this.environmentName === "docker"
        ? { kind: "artifacts", workdir: "/workspace", paths: ["/workspace/agentx-artifacts"] }
        : { kind: "artifacts", workdir: ".", paths: ["agentx-artifacts"] } };
  }

  async planRun(refs: TaskRef[], source: SourceLock, signal: AbortSignal, activity?: ActivityListener): Promise<BenchmarkRunPlan> {
    await mkdir(join(this.config.cacheDir, "objects"), { recursive: true });
    const tasks: PreparedTask[] = [];
    for (const ref of refs) {
      activity?.({ message: `Planning task ${tasks.length + 1}/${refs.length} ${ref.id}` });
      tasks.push(await withDatasetActivity(activity, () => this.prepare(ref, source, signal)));
      activity?.({ lines: [`Planning completed ${tasks.length}/${refs.length}`] });
    }
    return { tasks, preparation: { defaultTimeoutSeconds: 3600 }, policy: { version: "agentx-1.0.7-preparation-v2", source: "agentx profile" } };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal): Promise<VerifyResult> {
    signal.throwIfAborted();
    const summary = parseAgentXSummary(result.observations);
    if (fingerprintConfig(summary.workload) !== fingerprintConfig(task.verification))
      throw new TypeError("AgentX observations differ from the locked measurement point");
    return { passed: null, details: { measurement: "agentx", comparable: summary.comparable,
      upstreamSubmissionValid: summary.upstreamSubmissionValid, incomparableReasons: summary.incomparableReasons } };
  }
}
