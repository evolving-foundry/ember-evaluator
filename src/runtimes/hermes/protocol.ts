import type { ErrorCode } from "../../core/errors/registry.js";
import { open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";

export type HermesProtocolLimits = {
  maxStdoutBytes: number;
  maxStderrBytes: number;
};

export const DEFAULT_LIMITS: HermesProtocolLimits = {
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
};

export class HermesProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HermesProtocolError";
  }
}

function validatedLimits(value: HermesProtocolLimits): HermesProtocolLimits {
  const limits = { ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function redactText(value: string, secret: string): string {
  if (secret === "") return value;
  for (const sensitive of new Set([secret, encodeURIComponent(secret)])) {
    value = value.replaceAll(sensitive, "[redacted]");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CollectedText = { text: string; truncated: boolean };

async function collectText(source: AsyncIterable<Uint8Array>, maximum: number): Promise<CollectedText> {
  const chunks: Buffer[] = [];
  let retained = 0;
  let truncated = false;
  for await (const chunk of source) {
    const remaining = maximum - retained;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      chunks.push(Buffer.from(kept));
      retained += kept.byteLength;
    }
    if (chunk.byteLength > Math.max(0, remaining)) truncated = true;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks, retained)), truncated };
}

function stderrEvidence(value: CollectedText, secret: string, maximum: number): string {
  const text = redactText(value.text, secret);
  if (!value.truncated) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}[stderr truncated after ${maximum} bytes]\n`;
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Read usage and the Evaluator runner's typed terminal output evidence. */
async function readUsageFile(path: string): Promise<{ usage: Usage; truncatedFinalText: string | null }> {
  const unknown = { usage: { inputTokens: null, outputTokens: null, totalTokens: null }, truncatedFinalText: null };
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unknown;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { return unknown; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return unknown;
  const record = value as Record<string, unknown>;
  const output = record.evaluator_output;
  const truncatedFinalText = typeof output === "object" && output !== null && !Array.isArray(output)
    && "finishReason" in output && output.finishReason === "length"
    && "finalText" in output && typeof output.finalText === "string"
    && record.interrupted !== true && record.failure == null
    ? output.finalText : null;
  return {
    usage: { inputTokens: token(record["input_tokens"]),
      outputTokens: token(record["output_tokens"]),
      totalTokens: token(record["total_tokens"]) },
    truncatedFinalText,
  };
}

/**
 * Consume a Hermes headless (`-z`) run: gate on the exit code, treat stdout as
 * the final answer on success, or use captured model text for a confirmed
 * length-limited turn. Map `--usage-file` and synthesize the trajectory
 * (Hermes keeps no jsonl — its transcript lives in `state.db`).
 */
export async function consumeHermes(
  handle: ProcessHandle,
  context: AttemptContext,
  secret: string,
  usageFilePath: string,
  limits: HermesProtocolLimits = DEFAULT_LIMITS,
  startData?: JsonValue,
): Promise<SolveResult> {
  context.activity?.({ message: "Hermes is running; this executor does not provide live tool details", activity: false });
  limits = validatedLimits(limits);
  const sessionPath = join(context.paths.agent, "session.jsonl");
  const stderrPath = join(context.paths.agent, "stderr.log");
  const trajectory = new TrajectoryWriter(join(context.paths.agent, "trajectory.jsonl"), context.key);
  // The trajectory must begin with a durable start event: the collection gate
  // reads the prefix back and rejects any other first sequence type.
  await trajectory.append("start", startData ?? { harness: "hermes" }, true);
  let session: FileHandle;
  try { session = await open(sessionPath, "a", 0o600); }
  catch (error) {
    await Promise.allSettled([handle.stop(100), trajectory.close()]);
    throw error;
  }
  let stopRequested = false;
  const requestStop = async (): Promise<void> => {
    if (stopRequested) return;
    stopRequested = true;
    try { await handle.stop(100); } catch { /* preserve the primary error */ }
  };
  const onAbort = (): void => { void requestStop(); };
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) void requestStop();

  const stdout = collectText(handle.stdout, limits.maxStdoutBytes);
  const stderr = collectText(handle.stderr, limits.maxStderrBytes);
  try {
    const [exit, stderrText, stdoutText] = await Promise.all([handle.done, stderr, stdout]);
    await writeFile(stderrPath, stderrEvidence(stderrText, secret, limits.maxStderrBytes), { encoding: "utf8", mode: 0o600 });
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException("cancelled", "AbortError");
    const { usage, truncatedFinalText } = await readUsageFile(usageFilePath);
    // Pinned Hermes uses exit 2 for typed partial turns. Only the Evaluator
    // runner's confirmed provider-length result permits that exit to be scored.
    const truncated = truncatedFinalText !== null;
    if ((exit.code !== 0 && !(exit.code === 2 && truncated)) || exit.signal !== null) {
      const evidence = redactText(stdoutText.text, secret).trim() || redactText(stderrText.text, secret).trim();
      throw new HermesProtocolError(
        "SOLVER_PROCESS_CRASHED",
        `hermes exited with code ${String(exit.code)} and signal ${String(exit.signal)}${evidence ? `: ${evidence.slice(0, 2000)}` : ""}`,
      );
    }
    const finalText = redactText(truncatedFinalText ?? stdoutText.text, secret);
    if (truncated) {
      const warning = { code: "SOLVER_OUTPUT_LIMIT" as const,
        message: "Hermes model output was truncated (finish_reason=length); continuing evaluation with the actual output." };
      context.warning?.(warning);
      await trajectory.append("warning", warning);
    }
    const record = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      exitCode: exit.code,
      usage,
      ...(stdoutText.truncated ? { truncated: true } : {}),
    };
    await session.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    await trajectory.append("usage", usage);
    await trajectory.append("end", { status: "completed", finalText }, true);
    return { finalText, usage };
  } catch (error) {
    await requestStop();
    const settled = await Promise.allSettled([stdout, stderr, handle.done]);
    const settledStderr = settled[1]?.status === "fulfilled" ? settled[1].value : { text: "", truncated: false };
    const settledStdout = settled[0]?.status === "fulfilled" ? settled[0].value : { text: "", truncated: false };
    await writeFile(stderrPath, stderrEvidence(settledStderr, secret, limits.maxStderrBytes), { encoding: "utf8", mode: 0o600 });
    const failure = context.signal.aborted
      ? context.signal.reason ?? new DOMException("cancelled", "AbortError")
      : error;
    try {
      await trajectory.append("error", {
        code: failure instanceof HermesProtocolError ? failure.code : "SOLVER_PROTOCOL_INVALID",
        message: redactText(errorMessage(failure), secret),
        ...(settledStdout.text.trim() ? { stdoutTail: redactText(settledStdout.text.trim(), secret).slice(0, 2000) } : {}),
      }, true);
    } catch {
      // The original process/protocol/cancellation failure stays authoritative.
    }
    throw failure;
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([session.close(), trajectory.close()]);
  }
}
