import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ActivityListener } from "../../core/contracts/activity.js";
import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { formatError, redactDiagnostic } from "../../core/errors/diagnostics.js";
import { safeLiveText } from "../../core/progress/live-progress.js";
import { parseRunnerOutput, type RunnerOutput } from "../pi/protocol.js";

function redact(text: string, key: string): string {
  return redactDiagnostic(text, [key]);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function protocol(handle: ProcessHandle, activity: ActivityListener): Promise<{
  output: RunnerOutput | null; stderr: string; exit: { code: number | null; signal: string | null };
}> {
  let parsed: RunnerOutput | null = null;
  const consumeLine = (line: string) => {
    if (line === "") return;
    if (parsed !== null) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Dify runner emitted more than one terminal message");
    try {
      const message = parseRunnerOutput(JSON.parse(line));
      if (message.type === "activity") activity(message.activity);
      else if (message.type === "warning") throw new TypeError("Dify runner does not emit warnings");
      else parsed = message;
    } catch (error) {
      throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", error instanceof Error ? error.message : String(error), {}, { cause: error });
    }
  };
  const stdout = (async () => {
    let buffered = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of handle.stdout) {
      buffered += decoder.write(Buffer.from(chunk));
      if (buffered.length > 16 * 1024 * 1024) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Dify runner output exceeds protocol limit");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        consumeLine(line);
      }
    }
    buffered += decoder.end();
    if (buffered.trim() !== "") throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Dify runner stdout ended with an incomplete protocol line");
  })();
  const stderr = collect(handle.stderr);
  try {
    const [exit, diagnostic] = await Promise.all([handle.done, stderr, stdout]);
    return { output: parsed, stderr: diagnostic, exit };
  } catch (error) {
    await handle.stop(100).catch(() => {});
    if (typeof error === "object" && error !== null) {
      Object.defineProperty(error, "runnerStderr", { value: await stderr.catch(() => ""), configurable: true });
    }
    throw error;
  }
}

export async function consumeDify(handle: ProcessHandle, context: AttemptContext, signal: AbortSignal, apiKey: string): Promise<SolveResult> {
  let outcome: Awaited<ReturnType<typeof protocol>>;
  const writeStderr = (stderr: string) => writeFile(join(context.paths.agent, "runner-stderr.log"), redact(stderr, apiKey), { mode: 0o600 });
  try {
    outcome = await protocol(handle, item => context.activity?.({ ...item,
      ...(item.message === undefined ? {} : { message: safeLiveText(item.message, [apiKey]) }),
      ...(item.lines ? { lines: item.lines.map(line => safeLiveText(line, [apiKey])) } : {}),
    }));
  } catch (error) {
    const diagnostic = typeof error === "object" && error !== null && "runnerStderr" in error ? String(error.runnerStderr) : "";
    await writeStderr(diagnostic);
    signal.throwIfAborted();
    throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", redact(error instanceof Error ? error.message : String(error), apiKey), {},
      { cause: new Error(formatError(error, [apiKey])) });
  }
  await writeStderr(outcome.stderr);
  signal.throwIfAborted();
  if (outcome.output?.type === "error") {
    throw new EvaluatorError(outcome.output.code, redact(outcome.output.message, apiKey), outcome.output.details);
  }
  if (outcome.exit.code !== 0 || outcome.exit.signal !== null) {
    throw new EvaluatorError("SOLVER_PROCESS_CRASHED", redact(outcome.stderr.trim() ||
      `Dify runner exited with code ${outcome.exit.code ?? "null"} signal ${outcome.exit.signal ?? "none"}`, apiKey));
  }
  if (outcome.output?.type !== "result") throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Dify runner exited without a result message");
  return outcome.output.result;
}
