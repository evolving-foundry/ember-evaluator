import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, posix, sep } from "node:path";
import type { Benchmark } from "../../../../core/contracts/benchmark.js";
import type { SourceLock, TaskRef, PreparedTask } from "../../../../core/contracts/task.js";
import type { EnvironmentSession, EnvironmentSpec } from "../../../../core/contracts/environment.js";
import type { SolveResult, VerifyResult, EvaluationKind } from "../../../../core/contracts/result.js";
import { expectRecord, expectNonEmptyString, expectPositiveInteger, rejectUnknown, type EffectiveConfig } from "../../../../config/schema.js";
import type { HardwareKind } from "../../../../core/contracts/hardware.js";
import { assertKernelHardware, createKernelBackend, type KernelBackend } from "../../../../adapters/kernel/backend.js";
import { MAX_KERNEL_TIMER_MS, validateKernelExecOptions } from "../../../../adapters/kernel/cli.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import { parseKernelContract, kernelContractDigest, parseKernelAssessment } from "./strict.js";
import { kernelVerdict, kernelProfileVerdict } from "./result.js";

export function relativeFile(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => p === ".." || p === "." || !p) || posix.normalize(path) !== path)
    throw new TypeError(`${label} must be a relative file without traversal`);
  return path;
}

export function parseKernelConfig(value: unknown) {
  const c = expectRecord(value, "kernel");
  rejectUnknown(c, ["operation", "manifest", "kernelRoot", "python", "device", "seeds", "rtol", "atol", "warmup", "repeat", "timeoutSeconds", "outputLimitBytes", "cleanupGraceMs", "cleanupTimeoutMs", "profiling"], "kernel");
  const p = expectRecord(c.profiling ?? {}, "profiling");
  rejectUnknown(p, ["enabled", "collection", "warmup", "attemptTimeoutSeconds", "maxAttempts", "retryDelayMs", "roundNum", "msprofBin", "deviceName", "cacheEnabled", "cacheDir", "cacheMaxEntries"], "profiling");
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new TypeError("profiling.enabled must be boolean");
  if (p.cacheEnabled !== undefined && typeof p.cacheEnabled !== "boolean") throw new TypeError("profiling.cacheEnabled must be boolean");
  if (p.roundNum !== undefined && !Number.isSafeInteger(p.roundNum)) throw new TypeError("profiling.roundNum must be an integer");
  if (p.retryDelayMs !== undefined && (!Number.isSafeInteger(p.retryDelayMs) || Number(p.retryDelayMs) < 0))
    throw new TypeError("profiling.retryDelayMs must be a non-negative integer");
  const operation = c.operation ?? "evaluate";
  if (operation !== "evaluate" && operation !== "profile") throw new TypeError("kernel.operation must be evaluate or profile");
  const collection = p.collection === undefined ? "PipeTimeline,Default" : p.collection;
  if (collection !== "Default" && collection !== "PipeTimeline,Default")
    throw new TypeError("profiling.collection must be Default or PipeTimeline,Default");
  const profiling = {
    enabled: p.enabled === true,
    collection,
    warmup: expectPositiveInteger(p.warmup ?? 25, "profiling.warmup"),
    attemptTimeoutSeconds: expectPositiveInteger(p.attemptTimeoutSeconds ?? 300, "profiling.attemptTimeoutSeconds"),
    maxAttempts: expectPositiveInteger(p.maxAttempts ?? 2, "profiling.maxAttempts"),
    ...(p.retryDelayMs === undefined ? {} : { retryDelayMs: p.retryDelayMs as number }),
    roundNum: p.roundNum === undefined ? 1 : p.roundNum as number,
    cacheEnabled: p.cacheEnabled !== false,
    ...(p.cacheMaxEntries === undefined ? {} : { cacheMaxEntries: expectPositiveInteger(p.cacheMaxEntries, "profiling.cacheMaxEntries") }),
    ...(p.msprofBin === undefined ? {} : { msprofBin: expectNonEmptyString(p.msprofBin, "profiling.msprofBin") }),
    ...(p.deviceName === undefined ? {} : { deviceName: expectNonEmptyString(p.deviceName, "profiling.deviceName") }),
    ...(p.cacheDir === undefined ? {} : { cacheDir: expectNonEmptyString(p.cacheDir, "profiling.cacheDir") }),
  } as const;
  const timeoutSeconds = expectPositiveInteger(c.timeoutSeconds ??
    (profiling.enabled ? profiling.maxAttempts * profiling.attemptTimeoutSeconds + 300 : 300), "timeoutSeconds");
  const processOptions = {
    ...(c.outputLimitBytes === undefined ? {} : { outputLimitBytes: expectPositiveInteger(c.outputLimitBytes, "outputLimitBytes") }),
    cleanupGraceMs: expectPositiveInteger(c.cleanupGraceMs ?? 100, "cleanupGraceMs"),
    cleanupTimeoutMs: expectPositiveInteger(c.cleanupTimeoutMs ?? 3000, "cleanupTimeoutMs"),
  };
  validateKernelExecOptions(processOptions);
  if (timeoutSeconds * 1000 > MAX_KERNEL_TIMER_MS) throw new TypeError("timeoutSeconds exceeds the Node timer range");
  if (profiling.attemptTimeoutSeconds * 1000 > MAX_KERNEL_TIMER_MS)
    throw new TypeError("profiling.attemptTimeoutSeconds exceeds the Node timer range");
  const nonnegative = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
    return value;
  };
  const device = nonnegative(c.device ?? 0, "device");
  if (!Number.isSafeInteger(device)) throw new TypeError("device must be an integer");
  const seeds = c.seeds ?? [0, 1, 2];
  if (!Array.isArray(seeds) || !seeds.length || seeds.some(s => !Number.isSafeInteger(s) || s < 0 || s > 0xffffffff))
    throw new TypeError("seeds must contain unsigned 32-bit integers");
  if (new Set(seeds).size !== seeds.length) throw new TypeError("seeds must be unique");
  if (operation === "profile") {
    if (seeds.length !== 1) throw new TypeError("Independent profile requires a single seed");
    if (!profiling.enabled) throw new TypeError("Independent profile requires profiling.enabled=true");
    if (profiling.cacheEnabled) throw new TypeError("Independent profile requires cacheEnabled=false; callers own evidence reuse");
  }
  return { operation, manifest: expectNonEmptyString(c.manifest, "manifest"), ...(c.kernelRoot === undefined ? {} : { kernelRoot: expectNonEmptyString(c.kernelRoot, "kernelRoot") }),
    python: expectNonEmptyString(c.python ?? "python3", "python"), device, seeds: seeds as number[],
    rtol: nonnegative(c.rtol ?? 0.001, "rtol"), atol: nonnegative(c.atol ?? 0.001, "atol"),
    warmup: expectPositiveInteger(c.warmup ?? 5, "warmup"), repeat: expectPositiveInteger(c.repeat ?? 20, "repeat"),
    ...processOptions,
    timeoutSeconds, profiling };
}
export type KernelConfig = ReturnType<typeof parseKernelConfig>;

export function parseKernelManifest(value: unknown) {
  const m = expectRecord(value, "kernel manifest");
  rejectUnknown(m, ["schemaVersion", "tasks"], "kernel manifest");
  if (m.schemaVersion !== 1 || !Array.isArray(m.tasks) || !m.tasks.length) throw new TypeError("Expected schemaVersion 1 and nonempty tasks");
  const ids = new Set<string>();
  return m.tasks.map((value, index) => {
    const t = expectRecord(value, `tasks[${index}]`);
    rejectUnknown(t, ["id", "problem", "candidate", "files", "referenceKind", "outputIndices", "contract"], "kernel task");
    const id = expectNonEmptyString(t.id, "task.id");
    if (ids.has(id)) throw new TypeError(`Duplicate kernel task: ${id}`);
    ids.add(id);
    if (t.referenceKind !== "pytorch" && t.referenceKind !== "original-kernel") throw new TypeError("referenceKind must be pytorch or original-kernel");
    const files = t.files ?? [];
    if (!Array.isArray(files)) throw new TypeError("files must be an array");
    const indices = t.outputIndices;
    if (indices !== undefined && (!Array.isArray(indices) || !indices.length || indices.some(i => !Number.isSafeInteger(i) || i < 0) || new Set(indices).size !== indices.length))
      throw new TypeError("outputIndices must be unique nonnegative integers");
    return { id, problem: relativeFile(t.problem, "problem"), candidate: relativeFile(t.candidate, "candidate"),
      files: files.map(f => relativeFile(f, "files")), referenceKind: t.referenceKind,
      ...(t.contract === undefined ? {} : { contract: parseKernelContract(t.contract) }),
      ...(indices === undefined ? {} : { outputIndices: indices as number[] }) };
  });
}
export type KernelTask = ReturnType<typeof parseKernelManifest>[number];

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export class KernelBenchmark implements Benchmark {
  readonly evaluationKind: EvaluationKind;
  readonly validateSourceOnCompletedResume = true;
  private readonly backend: KernelBackend;
  constructor(private readonly config: KernelConfig, hardware: HardwareKind = "npu") {
    this.backend = createKernelBackend(hardware, config);
    this.evaluationKind = config.operation === "profile" ? "performance" : "quality";
  }

  validateRun(config: EffectiveConfig): void {
    assertKernelHardware(config.hardware ?? "npu");
    if (config.environment.name !== "local" || config.scheduler.name !== "local" || (config.scheduler.config.concurrency ?? 1) !== 1)
      throw new TypeError("kernel requires local environment and local scheduler concurrency 1");
    if (config.solver.name !== "kernel-replay") throw new TypeError("kernel requires the locked kernel-replay solver");
    if (config.verifier !== undefined) throw new TypeError("kernel uses its built-in verifier; remove benchmark.verifier");
    if (this.config.profiling.enabled && config.run.timeoutSeconds <= this.config.timeoutSeconds)
      throw new TypeError("run.timeoutSeconds must exceed kernel timeoutSeconds when profiling is enabled");
  }

  private async dataFile(path: string): Promise<string> {
    const root = await realpath(dirname(this.config.manifest));
    const file = await realpath(join(root, path));
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Kernel data file escapes manifest directory");
    return file;
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    const manifest = await readFile(this.config.manifest);
    const tasks = parseKernelManifest(JSON.parse(manifest.toString("utf8")));
    if (this.config.operation === "profile" && tasks.length !== 1) throw new TypeError("Independent profile requires a single task");
    const paths = [...new Set(tasks.flatMap(t => [t.problem, t.candidate, ...t.files]))].sort();
    const files = [{ path: "manifest.json", sha256: digest(manifest), origin: this.config.manifest }];
    for (const path of paths) {
      signal.throwIfAborted();
      const origin = await this.dataFile(path);
      files.push({ path: `data/${path}`, sha256: digest(await readFile(origin)), origin });
    }
    for (const { path, origin } of this.backend.runtimeFiles()) {
      files.push({ path, origin, sha256: digest(await readFile(origin)) });
    }
    const revision = digest(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
    if (previous && (previous.source !== "kernel-v1" || previous.revision !== revision)) throw new Error("Kernel evaluation source changed since locking");
    signal.throwIfAborted();
    return { source: "kernel-v1", revision, files, metadata: { schemaVersion: 1, tasks } };
  }

  async *enumerate(source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const task of parseKernelManifest(source.metadata)) {
      signal.throwIfAborted();
      yield { id: task.id, recordKey: task.id };
    }
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    await this.resolveSource(source, signal);
    const task = parseKernelManifest(source.metadata).find(t => t.id === ref.id && t.id === ref.recordKey);
    if (!task) throw new Error("Unknown kernel task reference");
    const file = (path: string) => {
      const item = source.files.find(f => f.path === path);
      if (!item) throw new Error(`Missing locked file: ${path}`);
      return item;
    };
    const candidate = file(`data/${task.candidate}`);
    const selected = [...new Set([task.problem, ...task.files])].map(path => file(`data/${path}`))
      .filter(item => item.path !== candidate.path);
    selected.push(...this.backend.runtimeFiles().map(item => file(item.path)));
    const env = (initialFiles: EnvironmentSpec["initialFiles"]): EnvironmentSpec => ({ workdir: ".", image: null, runtime: [], initialFiles,
      env: this.backend.environment() });
    return {
      input: { id: task.id, prompt: "Submit the frozen kernel artifact for independent evaluation.", payload: { candidateSha256: candidate.sha256 } },
      verification: { schemaVersion: 1, caseId: task.id, operation: this.config.operation, candidate: candidate.path, dataRoot: "data", candidateSha256: candidate.sha256,
        files: selected.map(f => ({ source: f.origin, target: f.path })),
        problem: `data/${task.problem}`, referenceKind: task.referenceKind, outputIndices: task.outputIndices ?? null,
        seeds: this.config.seeds, rtol: this.config.rtol, atol: this.config.atol, warmup: this.config.warmup, repeat: this.config.repeat,
        profiling: this.config.profiling,
        ...(task.contract === undefined ? {} : { contract: task.contract, contractSha256: kernelContractDigest(task.contract) }),
        hashes: Object.fromEntries([...selected.map(f => [f.path, f.sha256]), [candidate.path, candidate.sha256]]) },
      solveEnv: env([{ source: candidate.origin, target: candidate.path }]),
      verifyEnv: null, transfer: null, verificationMode: "shared",
      artifactCollection: { kind: "artifacts", workdir: ".", paths: [candidate.path] },
      phaseTimeoutSeconds: { verify: this.config.timeoutSeconds },
    };
  }

  async verify(task: PreparedTask, result: SolveResult, session: EnvironmentSession | null, signal: AbortSignal): Promise<VerifyResult> {
    if (!session) throw new Error("Kernel verification requires a private environment session");
    const { files, ...request } = expectRecord(task.verification, "kernel verification descriptor");
    if (result.finalText !== request.candidateSha256) throw new Error("Solver submitted a different kernel identity");
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutSeconds * 1000)]);
    if (!Array.isArray(files)) throw new Error("Missing verifier files");
    // Local sessions cannot restore archives; inject private materials only after the Solver finishes.
    for (const item of files) {
      const file = expectRecord(item, "verifier file");
      if (typeof file.source !== "string" || typeof file.target !== "string") throw new Error("Invalid verifier file");
      await session.upload(file.source, file.target, active);
    }
    const value = await this.backend.execute(request, session, active);
    const record = expectRecord(value, "kernel result");
    if (this.config.operation === "profile") {
      const hashes = expectRecord(request.hashes, "kernel source hashes");
      const verdict = kernelProfileVerdict(value, String(request.candidateSha256), String(request.referenceKind), {
        caseId: String(request.caseId), seed: this.config.seeds[0]!, warmup: this.config.profiling.warmup ?? 25,
        collection: this.config.profiling.collection,
        problemSha256: expectNonEmptyString(hashes[String(request.problem)], "problem source hash"),
        ...(request.contractSha256 === undefined ? {} : { contractSha256: String(request.contractSha256) }),
      });
      await writeFile(join(session.verifierOutputDir, "kernel-profile-result.json"), JSON.stringify(verdict.details, null, 2), "utf8");
      return verdict;
    }
    if (request.contract !== undefined) {
      const assessment = parseKernelAssessment(record.assessment, parseKernelContract(request.contract), this.config.seeds);
      for (const name of ["rtol", "atol", "warmup", "repeat"] as const)
        if (assessment.effectiveProtocol[name] !== this.config[name]) throw new VerificationError(`Effective protocol mismatch: ${name}`, {});
    }
    return kernelVerdict(value, String(request.candidateSha256), String(request.referenceKind), this.config.profiling.enabled,
      request.contract === undefined ? undefined : parseKernelContract(request.contract), this.config.seeds);
  }
}
