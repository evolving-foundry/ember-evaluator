import { loadedConfigSecrets } from "../application/config.js";
import { CommandUsageError, parseCommand as parseArgs } from "./commands.js";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { LoadedExecution } from "../application/run.js";
import { rebuildReport } from "../application/report/index.js";
import { formatError, redactDiagnostic, summarizeDiagnostic } from "../core/errors/diagnostics.js";
import type { ProgressEvent } from "../core/progress/progress.js";
import { openPluginRegistry, type PluginRegistry } from "../application/plugins/open-registry.js";
import { classifyError, normalizeFailure } from "../core/errors/classify.js";
import type { Phase } from "../core/contracts/result.js";
import { CliLiveProgress, type ProgressMode } from "./live-progress.js";
import { safeProgress } from "../core/progress/live-progress.js";
import type { ProgressListener } from "../core/progress/progress.js";

export type CliIO = { out(text: string): void; error(text: string): void; terminal?: NodeJS.WriteStream };
export const defaultIO: CliIO = {
  terminal: process.stderr,
  out: text => {
    process.stdout.write(text + "\n");
  },
  error: text => {
    process.stderr.write(text + "\n");
  },
};
import type { Command } from "./commands.js";
export type { Command } from "./commands.js";

export { parseCommand as parseArgs } from "./commands.js";

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

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  signal: AbortSignal = new AbortController().signal,
  execution?: LoadedExecution,
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
  execution: LoadedExecution | undefined,
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
      const { cleanupImages } = await import("../application/cleanup.js");
      const result = await cleanupImages({ ...command, signal, ...(execution ? { execution } : {}),
        onLoaded: config => secrets.push(...loadedConfigSecrets(config)) });
      io.out(JSON.stringify(result, null, 2));
      if (signal.aborted) return 130;
      return result.nodes.some(node => node.error || node.items.some(item => item.status === "failed")) ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 1; }
  }
  if (command.kind === "retry") {
    try {
      const { retryRun } = await import("../application/retry.js");
      return await retryRun(command, signal, io.out, progress);
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "init" || command.kind === "benchmark-list" || command.kind === "benchmark-info") {
    let registry: PluginRegistry | undefined;
    try {
      registry = await openPluginRegistry(command.patchPath);
      const { benchmarkList, benchmarkInfo, formatBenchmarkTable, initializeExperiment } = await import("../application/benchmarks.js");
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
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const { diagnoseExperiment } = await import("../application/inspection.js");
      const result = await diagnoseExperiment({ ...command, onLoaded: config => secrets.push(...loadedConfigSecrets(config)) }, signal, io.error);
      io.out(JSON.stringify(result, null, 2));
      return signal.aborted ? 130 : result.checks.some(check => check.status === "failed") || result.network.status !== "passed" ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
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
    try {
      const { executeKernelCommand } = await import("../application/kernel.js");
      const result = await executeKernelCommand(command, signal);
      if (result.kind === "evaluation-failed") { io.error(result.message); return 1; }
      io.out(JSON.stringify(result.payload, null, 2));
      return 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "inspect") {
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const { inspectExperiment } = await import("../application/inspection.js");
      const result = await inspectExperiment({ ...command, onLoaded: config => secrets.push(...loadedConfigSecrets(config)) });
      io.out(JSON.stringify(result.document, null, 2));
      if (result.runtimeCredentials)
        io.error("Runtime credentials were replaced with an EVALUATOR_API_KEY environment reference. Provide credentials through that variable or the CLI when running the exported configuration.");
      return 0;
    } catch (error) { failure(error); return 2; }
  }
  if (command.kind === "dry-run") {
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "", process.env.MODEL_API_KEY ?? "", process.env.JUDGE_MODEL_API_KEY ?? "");
    try {
      const { previewExperiment } = await import("../application/inspection.js");
      const taskIds = await readTaskIds(command.taskIdsFile);
      const result = await previewExperiment({ ...command, ...(taskIds === undefined ? {} : { taskIds }), onProgress: progress,
        onLoaded: config => secrets.push(...loadedConfigSecrets(config)),
        onDiagnostic: (current, error) => { phase = current; failure(error); } }, signal);
      if (result.taskIds !== null) io.out(JSON.stringify({ taskIds: result.taskIds }));
      return result.exitCode;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "warmup") {
    const { executeWarmup } = await import("../application/warmup.js");
    secrets.push(command.overrides.apiKey ?? "", ...Object.entries(process.env)
      .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
    try {
      const taskIds = await readTaskIds(command.taskIdsFile);
      const result = await executeWarmup({ ...networkOptions, configPath: command.file, overrides: command.overrides, signal, onProgress: progress,
        ...(execution ? { execution } : {}),
        ...(command.patchPath ? { patchPath: command.patchPath } : {}), ...(taskIds ? { taskIds } : {}),
        onLoaded: config => { secrets.push(...loadedConfigSecrets(config)); } });
      io.out(`Image warmup: ${result.readyTaskIds.length}/${result.taskIds.length} tasks ready; ${result.failures.length} failed`);
      for (const { taskId, failure } of result.failures) {
        io.out(`${taskId}: [${failure.code}] ${failure.message}`);
      }
      return result.status === "ready" ? 0 : 1;
    } catch (error) { failure(error); return signal.aborted ? 130 : ["arguments", "config", "bootstrap"].includes(phase) ? 2 : 1; }
  }
  // Keep full experiment imports outside the offline report path.
  const { executeExperiment } = await import("../application/run.js");
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
    onLoaded: config => { secrets.push(...loadedConfigSecrets(config)); },
    onDiagnostic: diagnostic => { phase = diagnostic.phase; failure(diagnostic.error); },
    onDeploymentLog: io.out,
  });
  if (outcome.result?.kind === "local" && outcome.diagnostics.length === 0) io.out(outcome.result.runDirectory);
  return outcome.exitCode;
}
