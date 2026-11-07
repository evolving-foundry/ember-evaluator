import type { ErrorCode } from "../../core/errors/registry.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { identifyNetworkFailure } from "../../core/errors/network-failure.js";
import { writeFile } from "node:fs/promises";
import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import { parseRunnerOutput, type RunnerOutput } from "./protocol.js";
import { StringDecoder } from "node:string_decoder";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { safeLiveText } from "../../core/progress/live-progress.js";

export class PiRunnerError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "PiRunnerError";
  }
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function protocol(
  handle: ProcessHandle,
  warning?: (warning: { code: ErrorCode; message: string }) => void,
  activity?: ActivityListener,
): Promise<{ output: RunnerOutput | null; stderr: string; exit: Awaited<ProcessHandle["done"]> }> {
  let parsed: RunnerOutput | null = null;
  let diagnostic = "";
  const warnings: string[] = [];
  const stdout = (async () => {
    let buffered = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of handle.stdout) {
      buffered += decoder.write(Buffer.from(chunk));
      if (buffered.length > 16 * 1024 * 1024) throw new PiRunnerError("SOLVER_PROTOCOL_INVALID", "runner output exceeds protocol limit");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line === "") continue;
        let message: RunnerOutput;
        try {
          message = parseRunnerOutput(JSON.parse(line));
        } catch (error) {
          throw new PiRunnerError("SOLVER_PROTOCOL_INVALID", error instanceof Error ? error.message : String(error), { cause: error });
        }
        if (parsed !== null) throw new PiRunnerError("SOLVER_PROTOCOL_INVALID", "runner emitted more than one terminal message");
        if (message.type === "activity") { activity?.(message.activity); continue; }
        if (message.type === "warning") {
          warnings.push(`[warning] ${message.code}: ${message.message}`);
          warning?.({ code: message.code, message: message.message });
          continue;
        }
        parsed = message;
      }
    }
    buffered += decoder.end();
    if (buffered.trim() !== "") throw new PiRunnerError("SOLVER_PROTOCOL_INVALID", "runner stdout ended with an incomplete protocol line");
  })();
  const stderr = collect(handle.stderr).then(value => {
    diagnostic = value;
    return value;
  });
  try {
    const [exit, diagnostic] = await Promise.all([handle.done, stderr, stdout]).then(
      ([exitResult, stderrText]) => [exitResult, stderrText] as const,
    );
    return { output: parsed, stderr: [diagnostic, ...warnings].filter(Boolean).join("\n"), exit };
  } catch (error) {
    await handle.stop(100).catch(() => {});
    await Promise.allSettled([handle.done, stderr, stdout]);
    if (typeof error === "object" && error !== null)
      Object.defineProperty(error, "runnerStderr", { value: diagnostic, configurable: true });
    throw error;
  }
}

export async function consumePiRunner(
  handle: ProcessHandle,
  auth: string,
  stderrPath: string,
  signal: AbortSignal,
  warning?: (warning: { code: ErrorCode; message: string }) => void,
  activity?: ActivityListener,
): Promise<SolveResult> {
  let outcome;
  try {
    outcome = await protocol(handle, item => warning?.({ code: item.code,
      message: auth === "" ? item.message : item.message.replaceAll(auth, "[redacted]") }), item => activity?.({ ...item,
        ...(item.message === undefined ? {} : { message: safeLiveText(item.message, [auth]) }),
        ...(item.lines ? { lines: item.lines.map(line => safeLiveText(line, [auth])) } : {}) }));
  } catch (error) {
    const diagnostic = typeof error === "object" && error !== null && "runnerStderr" in error
      ? String(error.runnerStderr)
      : "";
    const stderr = auth === "" ? diagnostic : diagnostic.replaceAll(auth, "[redacted]");
    await writeFile(stderrPath, stderr, { encoding: "utf8", mode: 0o600 });
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw error;
  }
  const stderr = auth === "" ? outcome.stderr : outcome.stderr.replaceAll(auth, "[redacted]");
  await writeFile(stderrPath, stderr, { encoding: "utf8", mode: 0o600 });
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  if (outcome.output?.type === "error") {
    const network = identifyNetworkFailure([outcome.output], { phase: "solve", component: "model" });
    if (network) throw new EvaluatorError("NETWORK_FAILURE", outcome.output.message, network);
    throw new PiRunnerError(outcome.output.code, outcome.output.message);
  }
  if (outcome.exit.code !== 0 || outcome.exit.signal !== null) {
    throw new PiRunnerError(
      "SOLVER_PROCESS_CRASHED",
      stderr.trim() || `runner exited with code ${outcome.exit.code ?? "null"} signal ${outcome.exit.signal ?? "none"}`,
    );
  }
  if (outcome.output?.type !== "result") throw new PiRunnerError("SOLVER_PROTOCOL_INVALID", "runner exited without a result message");
  return outcome.output.result;
}
