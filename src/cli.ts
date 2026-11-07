#!/usr/bin/env node
import { redactNetwork, networkSecrets } from "./config/network.js";
import { CommandUsageError, parseCommand as parseArgs } from "./cli-commands.js";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliOverrides, LoadedConfig } from "./config/schema.js";
import { rebuildReport } from "./report.js";
import { kernelBench, kernelPrecision, kernelProfile, KernelExecError, type KernelExecOptions } from "./adapters/kernel/cli.js";
import { formatError, redactDiagnostic, summarizeDiagnostic } from "./core/diagnostics.js";
import type { ProgressEvent } from "./core/progress.js";
import type { BenchmarkComponents } from "./core/contracts/components.js";
import { openPluginRegistry, type PluginRegistry } from "./plugin-runtime.js";
import { enumerateSelectedTasks } from "./core/task-selection.js";
import { classifyError, normalizeFailure } from "./core/errors/classify.js";
import type { Phase } from "./core/contracts/result.js";
import { CliLiveProgress, type ProgressMode } from "./cli-live-progress.js";
import { safeProgress } from "./core/live-progress.js";
import type { ProgressListener } from "./core/progress.js";
import { progressOperation } from "./core/progress-operation.js";

export type CliIO = { out(text: string): void; error(text: string): void; terminal?: NodeJS.WriteStream };
const defaultIO: CliIO = {
  terminal: process.stderr,
  out: text => {
    process.stdout.write(text + "\n");
  },
  error: text => {
    process.stderr.write(text + "\n");
  },
};
export type Command = (
  | { kind: "benchmark-list"; json: boolean; patchPath?: string }
  | { kind: "benchmark-info"; name: string; patchPath?: string }
  | { kind: "cleanup-images"; file?: string; all: boolean; execute: boolean; patchPath?: string }
  | { kind: "retry"; run: string; taskIds: string[]; requestId?: string; reason?: string }
  | { kind: "help"; text: string; exitCode?: number }
  | { kind: "init"; name: string; output: string; patchPath?: string }
  | { kind: "doctor"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "inspect"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "report"; directory: string }
  | ({ kind: "kernel-profile"; problem: string; kernel: string; out: string; round: number; seed: number; warmup: number; device: number; python?: string; maxAttempts?: number; attemptTimeoutSeconds?: number; cacheMaxEntries?: number; retryDelayMs?: number } & KernelExecOptions)
  | ({ kind: "kernel-precision"; problem: string; kernel: string; out: string; seeds: number[]; device: number; python?: string } & KernelExecOptions)
  | ({ kind: "kernel-bench"; problem: string; kernel: string; out: string; device: number; python?: string; warmup?: number; repeat?: number } & KernelExecOptions)
  | { kind: "run"; file: string; overrides: CliOverrides; resume?: string | null; taskIdsFile?: string; patchPath?: string }
  | { kind: "warmup"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
  | { kind: "dry-run"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
) & { networkConfigPath?: string };

export { parseCommand as parseArgs } from "./cli-commands.js";

async function readTaskIds(path: string | undefined): Promise<string[] | undefined> {
  if (path === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch {
    throw new TypeError("task IDs file must contain valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("task IDs file must be an object with taskIds");
  }
  const taskIds = (raw as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new TypeError("taskIds must be a non-empty array of non-empty strings");
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("taskIds must not contain duplicates");
  }
  return [...taskIds];
}

function applyTaskIds(config: LoadedConfig, taskIds: readonly string[] | undefined): void {
  if (taskIds === undefined) return;
  const run = { ...config.experiment.run };
  delete run.sampling;
  delete run.offset;
  config.experiment.run = { ...run, maxTasks: null, taskIds: [...taskIds] };
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  signal: AbortSignal = new AbortController().signal,
  execution?: { config: LoadedConfig; registry: PluginRegistry; runId?: string },
  observers?: { onProgress?: ProgressListener },
): Promise<number> {
  let mode: ProgressMode = "auto";
  const args = [...argv];
  const index = args.indexOf("--progress");
  if (index >= 0) {
    const value = args[index + 1];
    if (!["run", "retry", "warmup"].includes(args[0] ?? "") || index < 1 || !["auto", "tty", "plain"].includes(value ?? "") || args.lastIndexOf("--progress") !== index) {
      io.error("Invalid --progress option; expected auto, tty or plain on run/retry/warmup"); return 2;
    }
    mode = value as ProgressMode;
    args.splice(index, 2);
  }
  const stream = io.terminal;
  const live = CliLiveProgress.enabled(mode, stream) ? new CliLiveProgress(stream, text => io.error(text)) : undefined;
  const wrapped: CliIO = { out: text => live ? live.write(() => io.out(text)) : io.out(text),
    error: text => live ? live.write(() => io.error(text)) : io.error(text) };
  try {
    return await runCliCommand(args, wrapped, signal, execution, event => {
      live?.observe(event);
      observers?.onProgress?.(event);
    });
  } finally { live?.close(); }
}

async function runCliCommand(
  argv: string[], io: CliIO, signal: AbortSignal,
  execution: { config: LoadedConfig; registry: PluginRegistry; runId?: string } | undefined,
  onProgress: ProgressListener,
): Promise<number> {
  const started = performance.now();
  const debug = /^(1|true)$/i.test(process.env.EVALUATOR_DEBUG ?? "");
  const infoPhases = new Set([
    "deployment",
    "source",
    "resume",
    "recover",
    "retry",
    "execute",
    "install",
    "prepare",
    "environment",
    "solve",
    "transfer",
    "verify",
    "task",
    "report",
    "complete",
  ]);
  const secrets: string[] = [];
  let phase = "arguments";
  let detail = "Parsing command arguments";
  let networkHintShown = false;
  let debugHintShown = false;
  const writeHint = (message: string) => io.error(`[hint] ${message}`);
  const debugHint = () => {
    if (!debug && !debugHintShown) {
      debugHintShown = true;
      writeHint("Set EVALUATOR_DEBUG=1 for full errors and execution details. For saved tasks, see result.json / agent/stderr.log in the results directory.");
    }
  };
  const hint = (text: string) => {
    if (
      !networkHintShown &&
      /fetch failed|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_\w+)\b/i.test(text)
    ) {
      networkHintShown = true;
      writeHint("Check connectivity to the URL/host above (DNS, proxy, TLS). Use --network network.yaml to select download sources and per-location proxies; the default Hugging Face origin is https://huggingface.co. Model API variables do not configure dataset access.");
    }
  };
  const progress = (event: ProgressEvent) => {
    event = safeProgress(event, secrets);
    onProgress(event);
    if (event.transient) return;
    if (event.taskId === undefined) {
      phase = event.phase;
      detail = event.message;
    }
    const verbose = !infoPhases.has(event.phase);
    if (!debug && verbose && !event.error && !event.warning) return;
    const ordinal = event.taskNumber === undefined ? "" : `Task ${event.taskNumber}/${event.taskTotal} `;
    const task =
      event.taskId === undefined
        ? ""
        : ` ${ordinal}task=${event.taskId}${debug ? ` attempt=${event.attemptId ?? "unknown"}` : ""}`;
    const level = event.error ? "error" : event.warning ? "warning" : verbose ? "debug" : "info";
    const structured = event.failure ? normalizeFailure(event.failure, secrets) : undefined;
    const safeMessage = redactDiagnostic(structured && !event.message.startsWith(`${structured.code}:`)
      ? `${structured.code}: ${event.message}` : event.message, secrets);
    const message = event.error && !debug ? summarizeDiagnostic(safeMessage) : safeMessage;
    const text = redactDiagnostic(
      `[${((performance.now() - started) / 1000).toFixed(1)}s] [${level}] [${event.phase}]${task} ${event.error ? "ERROR: " : ""}${message}`,
      secrets,
    );
    io.error(structured ? `${text} [${structured.category}/${structured.scope}]\n[hint] ${structured.hint}` : text);
    if (event.error) {
      hint(text);
      debugHint();
    }
  };
  const failure = (error: unknown) => {
    const text = formatError(error, secrets);
    const failurePhase: Phase = ["dispose", "recover"].includes(phase) ? "cleanup" : phase === "finalize" ? "store"
      : phase === "solve" || phase === "verify" || phase === "cleanup" || phase === "transfer" || phase === "collect" || phase === "store" ? phase : "prepare";
    const component = ["arguments", "config", "bootstrap", "resume"].includes(phase) ? "config" : phase === "report" ? "report"
      : phase === "source" || phase === "enumerate" ? "source" : ["scheduler", "execute"].includes(phase) ? "scheduler" : "runtime";
    const structured = classifyError(signal.aborted ? signal.reason : error, { phase: failurePhase, component, secrets,
      ...(signal.aborted ? { cancellation: "user" } : {}) });
    io.error(redactDiagnostic(`[${phase}] ERROR during ${detail}:\n${structured.code} [${structured.category}/${structured.scope}]: ${debug ? text : summarizeDiagnostic(text)}\n[hint] ${structured.hint}`, secrets));
    hint(text);
    debugHint();
  };
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (error instanceof CommandUsageError) { failure(error); io.error(error.helpText); return 2; }
    failure(error);
    io.error("Use ember-evaluator <command> --help for usage and parameter details.");
    return 2;
  }
  const networkOptions = command.networkConfigPath === undefined ? {} : { networkConfigPath: command.networkConfigPath };
  if (command.kind === "help") {
    io.out(command.text);
    return command.exitCode ?? 0;
  }
  if (command.kind === "cleanup-images") {
    try {
      phase = "cleanup";
      detail = command.execute ? "Removing evaluator image references" : "Previewing evaluator image references";
      secrets.push(...Object.entries(process.env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
      const { cleanupImages } = await import("./cleanup.js");
      const result = await cleanupImages({ ...command, signal, ...(execution ? { execution } : {}),
        onLoaded: config => secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value).filter(Boolean)) });
      io.out(JSON.stringify(result, null, 2));
      if (signal.aborted) return 130;
      return result.nodes.some(node => node.error || node.items.some(item => item.status === "failed")) ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 1; }
  }
  if (command.kind === "retry") {
    try {
      const { retryRun } = await import("./retry.js");
      return await retryRun(command, signal, io.out, progress);
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "init" || command.kind === "benchmark-list" || command.kind === "benchmark-info") {
    let registry: PluginRegistry | undefined;
    try {
      registry = await openPluginRegistry(command.patchPath);
      const { benchmarkList, benchmarkInfo, formatBenchmarkTable, initializeExperiment } = await import("./commands/benchmark.js");
      if (command.kind === "benchmark-list") {
        const rows = benchmarkList(registry);
        io.out(command.json ? JSON.stringify(rows, null, 2) : formatBenchmarkTable(rows));
      } else if (command.kind === "benchmark-info") io.out(JSON.stringify(benchmarkInfo(registry, command.name), null, 2));
      else { await initializeExperiment(registry, command.name, command.output); io.out(command.output); }
      return 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
    finally { await registry?.dispose(); }
  }
  if (command.kind === "doctor") {
    let registry: PluginRegistry | undefined;
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const { diagnoseDownloads } = await import("./commands/network-diagnosis.js");
      registry = await openPluginRegistry(command.patchPath);
      const { loadConfig } = await import("./config/load.js");
      const { bootstrapBenchmark } = await import("./bootstrap.js");
      const { diagnose } = await import("./commands/doctor.js");
      const config = await loadConfig(resolve(command.file), command.overrides, process.env, { registry, ...networkOptions });
      secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value));
      await bootstrapBenchmark(config, dirname(resolve(command.file)), command.patchPath, registry);
      const checks = await diagnose(config, command.file, signal);
      const network = await diagnoseDownloads({ config, configPath: command.file,
        ...(command.patchPath ? { patchPath: command.patchPath } : {}) }, signal, io.error);
      io.out(JSON.stringify({ checks, network }, null, 2));
      const networkPassed = network.status === "passed";
      return signal.aborted ? 130 : checks.some(check => check.status === "failed") || !networkPassed ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
    finally { await registry?.dispose(); }
  }
  if (command.kind === "report") {
    progress({ phase: "report", message: `Computing metrics and generating a report from saved results: ${resolve(command.directory)}` });
    try {
      await rebuildReport(command.directory);
      io.out(join(resolve(command.directory), "report.md"));
      return 0;
    } catch (error) {
      failure(error);
      return 1;
    }
  }
  if (command.kind === "kernel-profile" || command.kind === "kernel-precision" || command.kind === "kernel-bench") {
    const options: KernelExecOptions = { signal,
      ...(command.python === undefined ? {} : { python: command.python }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(command.outputLimitBytes === undefined ? {} : { outputLimitBytes: command.outputLimitBytes }),
      ...(command.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: command.cleanupGraceMs }),
      ...(command.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: command.cleanupTimeoutMs }),
      ...(command.device === 0 ? {} : { device: command.device }) };
    try {
      const payload = command.kind === "kernel-profile" ? await kernelProfile(command, options)
        : command.kind === "kernel-precision" ? await kernelPrecision(command, options)
        : await kernelBench(command, options);
      io.out(JSON.stringify(payload, null, 2));
      return 0;
    } catch (error) {
      // Evaluation failures such as failed verification or missing measurements exit 1 under the kernel contract.
      // Infrastructure failures use the shared diagnostic path and exit 2, or 130 on cancellation.
      if (error instanceof KernelExecError && !error.infra) {
        io.error(error.message);
        return 1;
      }
      failure(error);
      return signal.aborted ? 130 : 2;
    }
  }
  if (command.kind === "inspect") {
    const { loadConfig } = await import("./config/load.js");
    const { exportConfig } = await import("./config/export.js");
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const config = await loadConfig(resolve(command.file), command.overrides, process.env, {
        allowMissingAuth: true, validatePlugins: true, ...networkOptions,
        ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }),
      });
      io.out(JSON.stringify({ experiment: exportConfig(config),
        network: { configPath: config.network!.origin, digest: config.network!.digest, settings: redactNetwork(config.network!.settings) } }, null, 2));
      if (JSON.stringify(config.persisted).includes("[runtime-provided]"))
        io.error("Runtime credentials were replaced with an EVALUATOR_API_KEY environment reference. Provide credentials through that variable or the CLI when running the exported configuration.");
      return 0;
    } catch (error) {
      failure(error);
      return 2;
    }
  }
  if (command.kind === "dry-run") {
    const { loadConfig } = await import("./config/load.js");
    const { bootstrapBenchmark } = await import("./bootstrap.js");
    secrets.push(
      command.overrides.apiKey ?? "",
      process.env[command.overrides.apiKeyEnv ?? ""] ?? "",
      process.env.MODEL_API_KEY ?? "",
      process.env.JUDGE_MODEL_API_KEY ?? "",
    );
    let config: LoadedConfig;
    let benchmarkComponents: BenchmarkComponents;
    let registry: PluginRegistry | undefined;
    try {
      const taskIds = await readTaskIds(command.taskIdsFile);
      progress({ phase: "config", message: `Loading and validating ${resolve(command.file)}` });
      registry = await openPluginRegistry(command.patchPath);
      config = await loadConfig(resolve(command.file), command.overrides, process.env, { registry, allowMissingAuth: true, ...networkOptions, ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }) });
      applyTaskIds(config, taskIds);
      secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value));
      progress({ phase: "bootstrap", message: `Initializing benchmark plugin: ${config.experiment.benchmark.name}` });
      benchmarkComponents = await bootstrapBenchmark(config, dirname(resolve(command.file)), command.patchPath, registry);
    } catch (error) {
      await registry?.dispose();
      failure(error);
      return signal.aborted ? 130 : 2;
    }
    let exitCode = 0;
    try {
      phase = "source";
      detail = `Resolving benchmark source ${config.experiment.benchmark.name}`;
      const source = await progressOperation(progress, { phase, message: `Preparing dataset ${config.experiment.benchmark.name} (checking the cache and downloading as needed)` }, signal,
        activity => benchmarkComponents.benchmark.resolveSource(null, signal, activity));
      phase = "enumerate";
      detail = `Enumerating tasks from ${source.source}`;
      const { selected } = await progressOperation(progress, { phase, message: `Reading tasks from ${source.source} revision=${source.revision}` }, signal,
        activity => enumerateSelectedTasks(
        benchmarkComponents.benchmark,
        source,
        config.experiment.run,
        signal,
        activity,
      ));
      signal.throwIfAborted();
      io.out(JSON.stringify({ taskIds: selected.map(ref => ref.id) }));
    } catch (error) {
      failure(error);
      exitCode = signal.aborted ? 130 : 2;
    } finally {
      progress({ phase: "dispose", message: "Releasing benchmark resources" });
      try {
        await benchmarkComponents.dispose();
        await registry?.dispose();
      } catch (error) {
        failure(error);
        if (exitCode !== 130) exitCode = 1;
      }
    }
    return exitCode;
  }
  if (command.kind === "warmup") {
    const { executeWarmup } = await import("./warmup.js");
    secrets.push(command.overrides.apiKey ?? "", ...Object.entries(process.env)
      .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
    try {
      const taskIds = await readTaskIds(command.taskIdsFile);
      const result = await executeWarmup({ ...networkOptions, configPath: command.file, overrides: command.overrides, signal, onProgress: progress,
        ...(execution ? { execution } : {}),
        ...(command.patchPath ? { patchPath: command.patchPath } : {}), ...(taskIds ? { taskIds } : {}),
        onLoaded: config => { secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value)); } });
      io.out(`Image warmup: ${result.readyTaskIds.length}/${result.taskIds.length} tasks ready; ${result.failures.length} failed`);
      for (const { taskId, failure } of result.failures) {
        io.out(`${taskId}: [${failure.code}] ${failure.message}`);
      }
      return result.status === "ready" ? 0 : 1;
    } catch (error) { failure(error); return signal.aborted ? 130 : ["arguments", "config", "bootstrap"].includes(phase) ? 2 : 1; }
  }
  // Keep full experiment imports outside the offline report path.
  const { executeExperiment } = await import("./run.js");
  secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "",
    process.env.MODEL_API_KEY ?? "", process.env.JUDGE_MODEL_API_KEY ?? "");
  let taskIds: string[] | undefined;
  try { taskIds = await readTaskIds(command.taskIdsFile); }
  catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  const outcome = await executeExperiment({ ...networkOptions, configPath: command.file, overrides: command.overrides, signal,
    ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }),
    ...(command.resume === undefined ? {} : { resume: command.resume === null ? true : command.resume }),
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(execution === undefined ? {} : { execution }),
    onProgress: progress,
    onLoaded: config => { secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value)); },
    onDiagnostic: diagnostic => { phase = diagnostic.phase; failure(diagnostic.error); },
    onDeploymentLog: io.out,
  });
  if (outcome.result?.kind === "local" && outcome.diagnostics.length === 0) io.out(outcome.result.runDirectory);
  return outcome.exitCode;
}

// Global package installs can invoke the CLI through a symlink or Windows junction.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("User cancelled", "AbortError"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), defaultIO, controller.signal);
  } catch (error) {
    defaultIO.error(formatError(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
