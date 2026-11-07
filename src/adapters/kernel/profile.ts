import { existsSync, readFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { parseMsprofMetricsTable, rowsToMetrics, metricsToCsv, type MetricRow } from "../../plugins/benchmarks/protocols/kernel/msprof-csv.js";
import { analyzeL2Cache, analyzeTraceEvents, extractTritonKernelName } from "../../plugins/benchmarks/protocols/kernel/msprof-analysis.js";
import { analyzeRoofline } from "../../plugins/benchmarks/protocols/kernel/roofline.js";
import { MsProfCache } from "../../plugins/benchmarks/protocols/kernel/msprof-cache.js";
import { KernelExecError, MAX_KERNEL_TIMER_MS, resolveAtomDir, validateKernelExecOptions, type KernelExecOptions } from "./cli.js";

import type { CommandSpec, EnvironmentSession } from "../../core/contracts/environment.js";
import { startLocalProcess } from "../../plugins/environments/process.js";
import { readProcess } from "../verifiers/process.js";

/** The SDK session owns all profiler children; standalone CLI calls own a process group. */
export type KernelProfileExecution = { session: Pick<EnvironmentSession, "start" | "workdir">; atomDirectory: string };
async function runProfileProcess(command: CommandSpec, signal: AbortSignal, options: KernelExecOptions, consolePath: string, execution?: KernelProfileExecution): Promise<void> {
  const handle = execution ? await execution.session.start({ ...command, cwd: execution.session.workdir }, signal)
    : await startLocalProcess(command, signal);
  try {
    const result = await readProcess(handle, signal, options.outputLimitBytes ?? null, options.cleanupGraceMs);
    await appendFileSafe(consolePath, `${result.stdout}${result.stderr}`);
    if (result.code !== 0) throw new ProfileStepError(`msprof exited with ${result.code}: ${result.stderr.slice(-4000)}`, true);
  } finally {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await handle.stop(options.cleanupGraceMs ?? 100);
      closed = await Promise.race([handle.done.then(() => true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), options.cleanupTimeoutMs ?? 3000); })]);
    } catch { /* The caller must retain the unconfirmed cleanup outcome. */ }
    finally { if (timer) clearTimeout(timer); }
    if (!closed) throw new KernelExecError("profile", null, "Profiling process cleanup unconfirmed", true, { cleanup: "unconfirmed" });
  }
}

/**
 * msprof capture orchestration, ported from adapters/kernel/msprof.py and kernel_profiler.
 * msprof_replay.py is the only Python worker executed under msprof.
 * This TypeScript layer owns request assembly, caching, msprof process retries, OPPROF CSV parsing,
 * ub_ratio, core utilization, L2 analysis and artifact contracts, preserving the Python artifact schema.
 */

const UPSTREAM_COMMIT = "f542552167fef844e10b865dc001e5c019f01ea5";
const OUTPUT_POLICY = "kernel-original-f542-v1";
const DEFAULT_MSPROF_BIN = "/usr/local/Ascend/ascend-toolkit/latest/bin/msprof";

export interface KernelProfileArgs { problem: string; kernel: string; out: string; round: number;
  seed?: number; warmup?: number; caseId?: string; contractSha256?: string; collection?: "Default" | "PipeTimeline,Default";
  msprofBin?: string; deviceName?: string; maxAttempts?: number; attemptTimeoutSeconds?: number; retryDelayMs?: number; cacheEnabled?: boolean; cacheDir?: string; cacheMaxEntries?: number }

/** Preserve the requested delay while respecting Node's signed 32-bit timer range. */
export async function waitForProfileRetry(attempt: number, retryDelayMs: number | undefined, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let remaining = retryDelayMs === undefined ? (1n << BigInt(attempt)) * 1000n : BigInt(retryDelayMs);
  const maxTimerMs = BigInt(MAX_KERNEL_TIMER_MS);
  while (remaining > 0n) {
    const milliseconds = remaining > maxTimerMs ? maxTimerMs : remaining;
    await delay(Number(milliseconds), undefined, signal === undefined ? {} : { signal });
    remaining -= milliseconds;
  }
}

export interface KernelProfileResult extends Record<string, unknown> {
  kernel: string; problem: string; round: number;
  metrics: Record<string, unknown> | null; profile_dir: string;
  trace_analysis: Record<string, unknown> | null;
  roofline: Record<string, unknown> | null; error: string;
}

/** Capture failure whose retryable flag controls whether another attempt is allowed. */
class ProfileStepError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Structurally missing capture artifacts are not retryable, matching FileNotFoundError handling. */
const NON_RETRYABLE_PREFIXES = [
  "No hash found", "No PipeUtilization.csv", "No L2Cache.csv",
  "No ResourceConflictRatio.csv", "No trace.json", "msprof binary not found",
  "msprof did not create OPPROF_",
];

/** Locate msprof: require explicit paths to exist, then prefer local CANN installations over PATH. */
function resolveMsprofBin(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    if (!existsSync(explicit)) throw new ProfileStepError(`msprof binary not found: ${explicit}`, false);
    return explicit;
  }
  if (existsSync(DEFAULT_MSPROF_BIN)) return DEFAULT_MSPROF_BIN;
  return "msprof";
}

async function listArtifacts(root: string, directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(resolve(path).replace(`${resolve(root)}/`, ""));
    }
  };
  await walk(directory);
  return out.sort();
}

function validateReplayProtocol(value: unknown, seed: number, warmup: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProfileStepError("Replay effective input protocol mismatch", false);
  const replay = value as Record<string, unknown>;
  if (replay.seed !== seed || replay.warmup !== warmup)
    throw new ProfileStepError("Replay effective input protocol mismatch", false);
  const captured = replay["capture"];
  if (captured === null || typeof captured !== "object" || Array.isArray(captured))
    throw new ProfileStepError("Replay effective capture protocol mismatch", false);
  const capture = captured as Record<string, unknown>;
  if (capture["method"] !== "mstx" || capture["range"] !== "rsi_operator_profile" || capture["toolId"] !== 0x1001 ||
      !Number.isSafeInteger(capture["rangeId"]) || Number(capture["rangeId"]) < 0 ||
      capture["warmupCompleted"] !== warmup || capture["callsInRange"] !== 1)
    throw new ProfileStepError("Replay effective capture protocol mismatch", false);
  if (!Number.isSafeInteger(replay["logicalDevice"]) || Number(replay["logicalDevice"]) < 0 ||
      !Number.isSafeInteger(replay["deviceCount"]) || Number(replay["deviceCount"]) <= Number(replay["logicalDevice"]) ||
      replay["environment"] === null || typeof replay["environment"] !== "object" || Array.isArray(replay["environment"]))
    throw new ProfileStepError("Replay device observations are invalid", false);
  return replay;
}

/** Replay cached metrics on a hit; otherwise spawn msprof with bounded capture attempts. */
export async function kernelProfile(args: KernelProfileArgs, options: KernelExecOptions = {}, execution?: KernelProfileExecution): Promise<KernelProfileResult> {
  validateKernelExecOptions(options);
  if (options.timeoutMs !== undefined && options.timeoutMs > 0)
    options = { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs)]) };
  options.signal?.throwIfAborted();
  const seed = args.seed ?? 0;
  const warmup = args.warmup ?? 25;
  const collection = args.collection === undefined ? "PipeTimeline,Default" : args.collection;
  if (collection !== "Default" && collection !== "PipeTimeline,Default")
    throw new TypeError("profiling.collection must be Default or PipeTimeline,Default");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError("seed must be an unsigned 32-bit integer");
  if (!Number.isSafeInteger(warmup) || warmup < 1) throw new TypeError("profiling warmup must be a positive integer");
  const maxAttempts = args.maxAttempts ?? 2;
  const attemptTimeoutSeconds = args.attemptTimeoutSeconds ?? 300;
  for (const [name, value] of [["maxAttempts", maxAttempts], ["attemptTimeoutSeconds", attemptTimeoutSeconds]] as const)
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  if (attemptTimeoutSeconds * 1000 > MAX_KERNEL_TIMER_MS)
    throw new TypeError("attemptTimeoutSeconds exceeds the Node timer range");
  if (args.cacheMaxEntries !== undefined && (!Number.isSafeInteger(args.cacheMaxEntries) || args.cacheMaxEntries <= 0))
    throw new TypeError("cacheMaxEntries must be a positive integer");
  if (args.retryDelayMs !== undefined && (!Number.isSafeInteger(args.retryDelayMs) || args.retryDelayMs < 0))
    throw new TypeError("retryDelayMs must be a non-negative integer");
  const cacheEnabled = args.cacheEnabled !== false;
  const sub = "profile";
  const atomDir = execution?.atomDirectory ?? resolveAtomDir(sub, options);
  const outPath = resolve(args.out);
  const dir = dirname(outPath);
  const stem = (args.out.split(/[/\\]/).pop() ?? "profile").replace(/\.json$/, "");
  const requestPath = join(dir, `${stem}.request.json`);
  const rawPath = join(dir, `${stem}.raw.json`);

  // Capture workspace: {stem}_profiling_root/profiling/{artifacts,logs}, preserving _collect_main naming.
  let root = join(dir, `${stem}_profiling_root`);
  for (let suffix = 0; existsSync(root);) {
    suffix += 1;
    root = join(dir, `${stem}_profiling_root_${suffix}`);
  }
  const profilingDir = join(root, "profiling");
  const artifactsDir = join(profilingDir, "artifacts");
  const logsDir = join(profilingDir, "logs");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const log = (line: string): void => {
    try { void appendFile(join(logsDir, "profiler.log"), `${new Date().toISOString()} INFO ${line}\n`, "utf8"); }
    catch { /* Log write failures must not interrupt capture. */ }
  };

  const kernelBytes = await readFile(args.kernel);
  // Stage the candidate with a .py suffix inside dataRoot: materialized content has no extension,
  // so spec_from_file_location cannot identify it. The staged path also satisfies the protocol
  // subtree check; retain the original path and hash in metadata for provenance.
  const stagedKernelPath = resolve(join(artifactsDir, "candidate_staged.py"));
  await writeFile(stagedKernelPath, kernelBytes);
  const request: Record<string, unknown> = {
    problem: args.problem,
    candidate: args.kernel,
    dataRoot: dirname(resolve(args.problem)),
    hashes: { [args.problem]: sha256File(args.problem), [args.kernel]: sha256File(args.kernel) },
    seeds: [seed], warmup,
    candidateSha256: sha256File(args.kernel), referenceKind: "problem-model",
    profiling: { enabled: true, collection, roundNum: args.round, cacheEnabled },
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");

  const result: Record<string, unknown> = {
    schemaVersion: 1, status: "failed", error: "", kernels: [],
    metadata: {
      outputPolicy: OUTPUT_POLICY, upstreamCommit: UPSTREAM_COMMIT,
      scope: "original-first-triton-kernel-or-file-stem",
      collection, seed, roundNum: args.round, attempts: 0, cleanup: "confirmed",
      diagnosticProtocol: { caseId: args.caseId ?? "standalone", seeds: [seed], warmup, collection,
        scope: "original-first-triton-kernel-or-file-stem", capture: "after-warmup-mstx-range", selectionPolicy: "last" },
      trace: { status: "unavailable", reason: collection === "Default" ? "not-requested-by-default-protocol" : "collection-not-completed" },
      hardwareDerived: { ubRatio: "unavailable", coreUtilization: "unavailable", reason: "No explicit hardware denominators provided" },
      cacheRequested: cacheEnabled, cacheHit: false,
      retryPolicy: { maxAttempts, attemptTimeoutSeconds, ...(args.retryDelayMs === undefined ? {} : { retryDelayMs: args.retryDelayMs }) },
    },
    artifacts: [],
  };
  const metadata = result.metadata as Record<string, unknown>;
  const started = Date.now();
  try {
    // Preserve the _prepare_wrapper request shape: absolute paths and hashes keyed by absolute path.
    const replayRequest = {
      problem: resolve(args.problem), candidate: stagedKernelPath,
      dataRoot: dirname(resolve(args.problem)),
      hashes: { [resolve(args.problem)]: (request.hashes as Record<string, string>)[args.problem],
        [stagedKernelPath]: (request.hashes as Record<string, string>)[args.kernel] },
      seeds: [seed], warmup,
    };
    const replayRequestPath = join(profilingDir, "request.json");
    await writeFile(replayRequestPath, JSON.stringify(replayRequest, null, 2), "utf8");
    metadata["sources"] = {
      candidate: { path: resolve(args.kernel), sha256: (request.hashes as Record<string, string>)[args.kernel] },
      problem: { path: replayRequest.problem, sha256: (request.hashes as Record<string, string>)[args.problem] },
      ...(args.contractSha256 === undefined ? {} : { contractSha256: args.contractSha256 }),
    };

    // Include visible devices and the target device in cache identity; timing evidence is device-specific.
    const visibleDevices = options.env?.ASCEND_RT_VISIBLE_DEVICES ?? process.env["ASCEND_RT_VISIBLE_DEVICES"];
    const deviceScope = visibleDevices === undefined
      ? (options.device === undefined ? undefined : `device-${options.device}`)
      : `${visibleDevices}${options.device === undefined ? "" : `:device-${options.device}`}`;
    // Only evidence from the same post-warmup capture protocol can satisfy a cache hit.
    const cacheScope = deviceScope === undefined ? undefined
      : `${deviceScope}:protocol=${JSON.stringify(metadata["diagnosticProtocol"])}:problem=${(request.hashes as Record<string, string>)[args.problem]}`;
    const cache = cacheEnabled ? await MsProfCache.open(cacheScope, args.cacheDir, log, args.cacheMaxEntries) : null;
    metadata["cacheEnabled"] = cache !== null;
    let metrics: Record<string, Record<string, unknown>> | null = null;
    let profileDir = "";
    let metricsRecords: Record<string, unknown>[] | null = null;
    const kernelName = extractTritonKernelName(args.kernel, kernelBytes.toString("utf8"));

    const cached = cache === null ? null
      : await cache.get(kernelBytes, cacheScope, log);
    metadata["cacheHit"] = cached !== null;
    if (cached !== null) {
      // Restore cached profiles into the artifact tree so profileDir remains relative and portable.
      metrics = cached.metrics as Record<string, Record<string, unknown>>;
      metricsRecords = cached.metricsRecords;
      const replay = validateReplayProtocol(cached.metadata["replay"], seed, warmup);
      metadata["replay"] = replay;
      await writeFile(join(profilingDir, "replay.json"), JSON.stringify(replay, null, 2), "utf8");
      if (cached.profileDir !== "" && existsSync(cached.profileDir)) {
        const copied = join(profilingDir, "cache-hit-profile");
        await cp(cached.profileDir, copied, { recursive: true });
        profileDir = copied;
      }
      log(`cache hit; metrics rebuilt from MSProfCache`);
    } else {
      const python = (execution ? options.python : process.env["KERNEL_PROFILER_PYTHON"] ?? options.python) ?? "python";
      const msprofBin = resolveMsprofBin(args.msprofBin);
      const outDirName = `msprof_round_${args.round}`;
      const outputDir = join(artifactsDir, outDirName);
      // The replay worker writes structured results to result.json instead of protocol stdout.
      // Prefer its actual evaluation error over downstream CSV-missing symptoms when capture fails.
      const replayResultPath = join(artifactsDir, "replay-result.json");
      const attemptTimeout = attemptTimeoutSeconds * 1000;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        metadata["attempts"] = attempt;
        log(`msprof profiling attempt ${attempt}/${maxAttempts}...`);
        // Isolate the Triton cache per attempt to prevent stale compilations from affecting autotune.
        const tritonCacheDir = join(artifactsDir, ".triton_cache", outDirName);
        await rm(tritonCacheDir, { recursive: true, force: true });
        await mkdir(tritonCacheDir, { recursive: true });
        const env: NodeJS.ProcessEnv = {
          ...process.env, ...options.env,
          ...(options.device === undefined ? {} : { KERNEL_NPU_DEVICE: String(options.device) }),
          PYTHONPATH: process.env.PYTHONPATH === undefined || process.env.PYTHONPATH === ""
            ? atomDir : `${atomDir}${delimiter}${process.env.PYTHONPATH}`,
          TRITON_CACHE_DIR: tritonCacheDir,
          ENABLE_PRINT_UB_BITS: "true",
          TRITON_PRINT_AUTOTUNING: "1",
          // msprof forwards only PRESERVE_ENV variables to the worker; explicitly preserve device bindings.
          PRESERVE_ENV: ["PATH", "LD_LIBRARY_PATH", "PYTHONPATH", "TRITON_CACHE_DIR", "TORCH_EXTENSIONS_DIR",
            "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "ASCEND_VISIBLE_DEVICES", "ASCEND_AICPU_PATH",
            "ASCEND_RT_VISIBLE_DEVICES", "KERNEL_NPU_DEVICE"].join(","),
        };
        try {
          const application = `${python} ${join(atomDir, "msprof_replay.py")} --request ${replayRequestPath} --output ${replayResultPath}`;
          const active = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(attemptTimeout)]);
          await runProfileProcess({ executable: msprofBin,
            args: ["op", `--output=${outputDir}`, `--application=${application}`,
              `--kernel-name=${kernelName}`, `--aic-metrics=${collection}`,
              "--mstx=on", "--mstx-include=rsi_operator_profile"],
            cwd: artifactsDir, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
            input: null, outputBufferBytes: null }, active, options, join(logsDir, "console.log"), execution);
          const profDirs = (await exists(outputDir))
            ? (await readdir(outputDir)).filter(name => name.startsWith("OPPROF_")).sort()
            : [];
          if (profDirs.length === 0)
            throw new ProfileStepError(`msprof did not create OPPROF_* directory in ${outputDir}`, false);
          const profDir = join(outputDir, profDirs[profDirs.length - 1]!);
          const rows: MetricRow[] = await parseMsprofMetricsTable(profDir);
          const table = rowsToMetrics(rows);
          const coreKeys = ["aiv_vec_ratio", "aiv_scalar_ratio", "aiv_mte2_ratio", "aiv_mte3_ratio", "aic_cube_ratio"];
          if (!Object.values(table).some(row => coreKeys.some(key => typeof row[key] === "number" && Number.isFinite(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= 1)))
            throw new ProfileStepError("No valid core pipe metrics", false);
          const replay = validateReplayProtocol(JSON.parse(await readFile(replayResultPath, "utf8")), seed, warmup);
          metadata["replay"] = replay;
          await writeFile(join(profilingDir, "replay.json"), JSON.stringify(replay, null, 2), "utf8");
          const l2 = await analyzeL2Cache(profDir);
          for (const entry of Object.values(table)) entry["l2_cache_analysis"] = l2;
          metadata["metricUnits"] = Object.fromEntries([...new Set(Object.values(table).flatMap(row => Object.keys(row)))].map(name => [name,
            name.endsWith("_ratio") ? "ratio" : name.endsWith("(%)") ? "percent" : name.endsWith("(us)") ? "microseconds" :
              name.endsWith("(GB/s)") ? "GB/s" : name.endsWith("(KB)") ? "KB" : name.endsWith("_instructions") ? "count" : "structured-analysis"]));
          metadata["missingMetrics"] = coreKeys.filter(key => !Object.values(table).some(row => typeof row[key] === "number"));
          metrics = table;
          profileDir = profDir;
          log(`msprof profiling completed (round ${args.round})`);
          break;
        } catch (error) {
          if (error instanceof KernelExecError) throw error;
          options.signal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          // Prefer the structured replay error when available; missing CSV or directories in msprof
          // output may only be downstream symptoms.
          try {
            const replayResult = JSON.parse(await readFile(replayResultPath, "utf8")) as Record<string, unknown>;
            if (typeof replayResult["error"] === "string" && replayResult["error"] !== "")
              throw new ProfileStepError(`replay kernel failed: ${replayResult["error"]}`, false);
          } catch (readError) {
            if (readError instanceof ProfileStepError) throw readError;
            // Missing or invalid result file: classify the original msprof error.
          }
          const timedOut = (error as { killed?: boolean }).killed === true;
          // Structural omissions (directories, CSV, traces or compilation metadata) are not retryable.
          // Timeouts, nonzero exit codes and invalid ub_ratio values may be transient msprof failures.
          const retryable = error instanceof ProfileStepError ? error.retryable : timedOut || !NON_RETRYABLE_PREFIXES.some(prefix => message.includes(prefix));
          lastError = error instanceof Error ? error : new Error(message);
          log(`attempt ${attempt} failed: ${message}`);
          if (!retryable || attempt >= maxAttempts) break;
          await waitForProfileRetry(attempt, args.retryDelayMs, options.signal);
        }
      }
      if (metrics === null)
        throw lastError ?? new Error("msprof profiling failed without diagnostics");
    }

    if (metrics !== null) {
      if (collection === "PipeTimeline,Default") {
        let trace: { traceEvents?: unknown };
        try { trace = JSON.parse(await readFile(join(profileDir, "trace.json"), "utf8")) as { traceEvents?: unknown }; }
        catch { throw new ProfileStepError("No trace.json valid data found", false); }
        if (!Array.isArray(trace.traceEvents)) throw new ProfileStepError("No trace.json events found", false);
        metadata["trace"] = { status: "available", artifact: "trace.json" };
      }
      const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const originalMetadata = {
        kernel_file: resolve(args.kernel), problem_file: resolve(args.problem),
        round_num: args.round, timestamp, msprof_version: null,
      };
      // round{N}_msprof_metrics.json, metrics-dataframe.csv and original-result.json
      // preserve the Python artifact set for archiving and reconciliation.
      await writeFile(join(logsDir, `round${String(args.round).padStart(3, "0")}_msprof_metrics.json`),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      await writeFile(join(profilingDir, "metrics-dataframe.csv"),
        metricsToCsv(metricsRecords === null
          ? Object.entries(metrics).map(([blockId, entry]) => ({ block_id: blockId, ...entry }) as MetricRow)
          : metricsRecords as MetricRow[]), "utf8");
      await writeFile(join(profilingDir, "original-result.json"),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      metadata["originalMetadata"] = originalMetadata;
      if (profileDir !== "") metadata["profileDir"] = relativeTo(root, profileDir);
      const replayJsonPath = join(profilingDir, "replay.json");
      if (existsSync(replayJsonPath))
        metadata["replay"] = JSON.parse(await readFile(replayJsonPath, "utf8")) as unknown;
      const artifacts = await listArtifacts(root, profilingDir);
      result["kernels"] = [{
        name: kernelName, metrics,
        metadata: { ...metadata }, artifacts,
      }];
      result["status"] = "completed";
      result["error"] = "";
      if (cache !== null)
        await cache.put(kernelBytes, cacheScope, profileDir,
          metrics,
          { ...(metadata as Record<string, unknown>), round_num: args.round,
            device: process.env["ASCEND_RT_VISIBLE_DEVICES"], problem_file: resolve(args.problem) },
          metricsRecords);
    }
  } catch (error) {
    if (error instanceof KernelExecError) throw error;
    options.signal?.throwIfAborted();
    result["error"] = `${error instanceof Error ? error.name : "Error"}: ${
      error instanceof Error ? error.message : String(error)}`;
    log(`profiling failed: ${result["error"]}`);
  }
  metadata["durationSeconds"] = (Date.now() - started) / 1000;
  result["artifacts"] = [...await listArtifacts(root, profilingDir), "profiling/result.json"];

  const payload: Record<string, unknown> = {
    kernel: args.kernel, problem: args.problem, round: args.round,
    measured_by: "rsi-profile", metrics: null, profile_dir: "", trace_analysis: null, error: "",
  };
  if (result["status"] === "completed") {
    const entry = (result.kernels as Record<string, unknown>[])[0] ?? {};
    payload["metrics"] = entry["metrics"] ?? {};
    const rel = String((entry.metadata as Record<string, unknown>)?.["profileDir"] ?? "");
    payload["profile_dir"] = rel !== "" ? resolve(join(root, rel)) : "";
  } else {
    payload["error"] = String(result["error"]) || "msprof profiling returned no kernels";
  }
  if (payload["profile_dir"] !== "") {
    // Only the explicitly requested full protocol reads or analyzes pipeline trace data.
    if (collection === "PipeTimeline,Default") try {
      const profDir = String(payload["profile_dir"]);
      const traceData = JSON.parse(await readFile(join(profDir, "trace.json"), "utf8")) as { traceEvents?: unknown };
      const analysis = analyzeTraceEvents(traceData.traceEvents);
      if (analysis !== null) {
        payload["trace_analysis"] = analysis;
        await writeFile(join(profDir, "trace_analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
      }
    } catch { /* Trace analysis remains null when it cannot be derived. */ }
    // Roofline classification consumes only the metrics table and runs as part of capture.
    // Classification failure leaves the capture result usable with the default "no" classification.
    const metricsTable = payload["metrics"];
    if (metricsTable !== null && typeof metricsTable === "object" && Object.keys(metricsTable as object).length > 0)
      payload["roofline"] = analyzeRoofline(metricsTable as Record<string, Record<string, unknown>>) as unknown;
  }
  result["analysis"] = { trace: payload["trace_analysis"] ?? null, roofline: payload["roofline"] ?? null };
  await writeFile(join(profilingDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(rawPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { kernel: args.kernel, problem: args.problem, round: args.round,
    metrics: payload["metrics"] as Record<string, unknown> | null,
    profile_dir: String(payload["profile_dir"]),
    trace_analysis: (payload["trace_analysis"] ?? null) as Record<string, unknown> | null,
    roofline: (payload["roofline"] ?? null) as Record<string, unknown> | null,
    error: String(payload["error"]) };
}

/** Convert to relative paths; return absolute paths outside the root for the caller to handle. */
function relativeTo(root: string, path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  const base = resolve(root).replace(/\\/g, "/");
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function appendFileSafe(path: string, text: string): Promise<void> {
  try {
    await appendFile(path, text, "utf8");
  } catch {
    // Failure to persist console.log output must not interrupt capture.
  }
}
