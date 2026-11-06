import type { ErrorCode } from "../../core/errors/registry.js";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { PhaseTimeoutError } from "../../core/policies/phase-timeout.js";
import { ModelOutputTruncatedError } from "../../core/policies/model-output-truncated.js";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";

const DEFAULT_LIMITS = {
  maxEnvelopeBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
};

class JiuwenswarmProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = "JiuwenswarmProtocolError";
  }
}

function malformed(label: string, message: string, options?: ErrorOptions): JiuwenswarmProtocolError {
  return new JiuwenswarmProtocolError("SOLVER_PROTOCOL_INVALID", `${label} ${message}`, options);
}

function outputLimit(label: string, message: string): JiuwenswarmProtocolError {
  return new JiuwenswarmProtocolError("SOLVER_PROTOCOL_INVALID", `${label} ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed("jiuwenswarm", `${path} must be an object`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw malformed("jiuwenswarm", `${path} must be a string`);
  return value;
}

/** First string field among the payload keys the runtime writes for assistant text. */
function text(payload: Record<string, unknown>): string {
  for (const key of ["delta", "content", "text", "message", "answer"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function redactText(value: string, secret: string): string {
  if (secret === "") return value;
  for (const sensitive of new Set([secret, encodeURIComponent(secret)])) {
    value = value.replaceAll(sensitive, "[redacted]");
  }
  return value;
}

/** Tool arguments/results can nest credentials in JSON values or property names. */
function redact(value: unknown, secret: string): JsonValue {
  if (typeof value === "string") return redactText(value, secret);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (!isRecord(value)) return null;
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, item] of Object.entries(value)) result[redactText(key, secret)] = redact(item, secret);
  return result;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value !== "") ?? null;
}

/** The native tool_call payload uses name/arguments/tool_call_id. */
function toolCallData(payload: Record<string, unknown>, secret: string): JsonValue {
  const call = isRecord(payload.tool_call) ? payload.tool_call : payload;
  const fn = isRecord(call.function) ? call.function : {};
  let input: unknown = call.arguments ?? fn.arguments ?? call.input ?? null;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      // Some tools use a plain string argument; preserve it as diagnostic data.
    }
  }
  return redact({
    callId: firstString(call.tool_call_id, call.toolCallId, call.id),
    tool: firstString(call.name, call.tool_name, fn.name, call.tool) ?? "unknown",
    input,
  }, secret);
}

function toolResultData(payload: Record<string, unknown>, secret: string): JsonValue {
  const result = isRecord(payload.tool_result) ? payload.tool_result : payload;
  const failed = result.success === false || result.is_error === true ||
    ["error", "failed", "interrupted", "cancelled"].includes(String(result.status));
  return redact({
    callId: firstString(result.tool_call_id, result.toolCallId, result.id),
    tool: firstString(result.tool_name, result.name, result.tool) ?? "unknown",
    status: failed ? "error" : "completed",
    // rendered_result is the text the model actually received; result is the
    // runtime's compatibility display string, raw_output its structured fallback.
    result: result.rendered_result ?? result.result ?? result.raw_output ?? null,
  }, secret);
}

function errorInfo(payload: Record<string, unknown>): string {
  const raw = payload.error;
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  if (isRecord(raw)) {
    const nested = raw.message ?? raw.content;
    if (typeof nested === "string" && nested.trim() !== "") return nested;
  }
  const message = payload.message ?? payload.content;
  if (typeof message === "string" && message.trim() !== "") return message;
  return "Runtime execution failed";
}

function runtimeFailure(event: Record<string, unknown>, payload: Record<string, unknown>, secret: string): Error {
  const diagnostic = new JiuwenswarmProtocolError(
    "INTERNAL_ERROR",
    `jiuwenswarm reported an error: ${redactText(errorInfo(payload), secret)}`,
  );
  // Only the native response guard's exact, typed terminal event is recoverable.
  // Missing contexts and context-update failures are runtime errors, not truncation.
  if (event.channel_id === "process_cli" && payload.event_type === "chat.error" &&
    payload.error_type === "EmptyLengthResponseError") {
    for (const reason of ["recovery-exhausted", "iteration-budget-exhausted"] as const) {
      if (payload.error === `EMPTY_TRUNCATED_MODEL_RESPONSE: ${reason}; recovery limit=1`)
        return new ModelOutputTruncatedError(reason, diagnostic.message, { cause: diagnostic });
    }
  }
  // The current process CLI has no typed deadline field. Match only its own
  // explicit deadline event; an arbitrary tool/model timeout is not this phase.
  if (event.channel_id === "process_cli" && event.ok === false && payload.event_type === "runtime.error" &&
    payload.error === "process CLI execution timed out") {
    return new PhaseTimeoutError("solve", diagnostic.message, { cause: diagnostic });
  }
  return diagnostic;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function counter(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function usageOf(payload: Record<string, unknown>): Usage | null {
  const usage = payload.usage;
  if (!isRecord(usage)) return null;
  const input = counter(usage.input_tokens);
  const output = counter(usage.output_tokens);
  const total = counter(usage.total_tokens);
  if (input === null && output === null && total === null) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/** `chat.usage_metadata` carries counters nested under `metadata.usage_metadata`. */
function usageMetadataOf(payload: Record<string, unknown>): Usage | null {
  const metadata = payload.metadata;
  if (!isRecord(metadata)) return null;
  const usage = metadata.usage_metadata;
  if (!isRecord(usage)) return null;
  const input = counter(usage.input_tokens);
  const output = counter(usage.output_tokens);
  const total = counter(usage.total_tokens);
  if (input === null && output === null && total === null) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/** Assemble assistant text the same way the runtime's own one-shot summary does. */
function assembleText(deltas: string, final: string): string {
  if (final !== "" && final.startsWith(deltas)) return final;
  if (final !== "" && !deltas.includes(final)) return deltas + final;
  return deltas === "" ? final : deltas;
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

/**
 * Parse the one-shot `jiuwenswarm-process --output json` envelope. The process
 * exits 0 even when the runtime reports an error, so the envelope's `ok` and
 * event-level `chat.error` / `runtime.error` payloads are authoritative.
 */
export function parseJiuwenswarmEnvelope(text: string): { ok: boolean; events: unknown[] } {
  const trimmed = text.trim();
  if (trimmed === "") throw malformed("jiuwenswarm", "stdout is empty; no JSON envelope was produced");
  const envelopes: Array<{ ok: boolean; events: unknown[] }> = [];
  const inspect = (value: unknown): void => {
    const envelope = record(value, "envelope");
    const ok = envelope.ok;
    if (typeof ok !== "boolean") throw malformed("jiuwenswarm", "envelope.ok must be a boolean");
    const events = envelope.events;
    if (!Array.isArray(events)) throw malformed("jiuwenswarm", "envelope.events must be an array");
    envelopes.push({ ok, events });
  };
  try {
    inspect(JSON.parse(trimmed) as unknown);
  } catch {
    // Multi-record output (e.g. an unrelated line before the envelope) still
    // yields one terminal envelope; the last record wins.
    let found = false;
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        inspect(JSON.parse(line) as unknown);
        found = true;
      } catch {
        // Skip non-JSON diagnostic lines; the final envelope is authoritative.
      }
    }
    if (!found) throw malformed("jiuwenswarm", "stdout did not contain a JSON envelope");
  }
  return envelopes.at(-1) ?? { ok: false, events: [] };
}

/**
 * Consume the jiuwenswarm JSON event envelope and persist the native evidence.
 * `finalText` feeds the benchmark grader; usage counters are best-effort.
 */
export async function consumeJiuwenswarm(
  handle: ProcessHandle,
  context: AttemptContext,
  secret: string,
  limits: typeof DEFAULT_LIMITS = DEFAULT_LIMITS,
): Promise<SolveResult> {
  context.activity?.({ message: "JiuwenSwarm is running; this executor does not provide live tool details", activity: false });
  const sessionPath = join(context.paths.agent, "session.jsonl");
  const stderrPath = join(context.paths.agent, "stderr.log");
  const trajectory = new TrajectoryWriter(join(context.paths.agent, "trajectory.jsonl"), context.key);
  // The trajectory must begin with a durable start event: the collection gate
  // reads the prefix back and rejects any other first sequence type.
  await trajectory.append("start", { harness: "jiuwenswarm" }, true);
  let session: FileHandle;
  try {
    session = await open(sessionPath, "a", 0o600);
  } catch (error) {
    await Promise.allSettled([handle.stop(100), trajectory.close()]);
    throw error;
  }
  const stdout = collectText(handle.stdout, limits.maxEnvelopeBytes);
  const stderr = collectText(handle.stderr, limits.maxStderrBytes);
  let stopRequested = false;
  const requestStop = async (): Promise<void> => {
    if (stopRequested) return;
    stopRequested = true;
    try {
      await handle.stop(100);
    } catch {
      // Preserve the protocol or cancellation error that required termination.
    }
  };
  const onAbort = (): void => {
    void requestStop();
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) void requestStop();

  try {
    const [exit, stdoutText, stderrText] = await Promise.all([handle.done, stdout, stderr]);
    await writeFile(stderrPath, stderrEvidence(stderrText, secret, limits.maxStderrBytes), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException("cancelled", "AbortError");
    if (stdoutText.truncated) throw outputLimit("jiuwenswarm", `stdout exceeded ${limits.maxEnvelopeBytes} bytes`);
    const envelope = parseJiuwenswarmEnvelope(stdoutText.text);
    let deltas = "";
    let final = "";
    let error: Error | undefined;
    let outputTruncated = false;
    let usage: Usage | null = null;
    let pendingDeltas = "";
    let pendingFinal = "";
    const flushText = async (): Promise<void> => {
      const value = assembleText(pendingDeltas, pendingFinal);
      if (value !== "") await trajectory.append("text", { text: redactText(value, secret) });
      pendingDeltas = "";
      pendingFinal = "";
    };
    for (const raw of envelope.events) {
      const event = record(raw, "event");
      // A terminal event may carry no payload (`payload: null`); treat it as
      // an empty record instead of a protocol error.
      const payload =
        event.payload === null || event.payload === undefined ? {} : record(event.payload, "event.payload");
      if (typeof payload.event_type !== "string") continue;
      const eventType = payload.event_type;
      if (eventType === "chat.delta") {
        const value = text(payload);
        deltas += value;
        pendingDeltas += value;
      } else if (eventType === "chat.final") {
        const value = text(payload);
        if (value !== "") {
          final = value;
          pendingFinal = value;
        }
      } else if (eventType === "chat.tool_call" || eventType === "tool.use") {
        // Coalesce streaming text at tool boundaries so thousands of deltas do
        // not become redundant events or duplicate the eventual chat.final.
        await flushText();
        await trajectory.append("tool_call", toolCallData(payload, secret));
      } else if (eventType === "chat.tool_result" || eventType === "tool.result") {
        await flushText();
        await trajectory.append("tool_result", toolResultData(payload, secret));
      }
      if (eventType === "chat.usage_summary") {
        const mapped = usageOf(payload);
        if (mapped !== null) usage = mapped;
      }
      if (eventType === "chat.usage_metadata" && usage === null) {
        const mapped = usageMetadataOf(payload);
        if (mapped !== null) usage = mapped;
      }
      if (eventType === "chat.error" || eventType === "runtime.error" || event.ok === false) {
        const failure = runtimeFailure(event, payload, secret);
        if (failure instanceof ModelOutputTruncatedError) {
          outputTruncated = true;
          const warning = { code: failure.code,
            message: `${failure.message}; continuing evaluation with the actual output.` };
          context.warning?.(warning);
          await trajectory.append("warning", warning);
        } else {
          error ??= failure;
        }
      }
    }
    // RSI's trajectory reader consumes data.text rather than end.finalText.
    await flushText();
    if (!envelope.ok && error === undefined && !outputTruncated)
      error = new JiuwenswarmProtocolError("INTERNAL_ERROR", "jiuwenswarm reported an error: Runtime reported an unsuccessful completion");
    if (error !== undefined) throw error;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new JiuwenswarmProtocolError(
        "SOLVER_PROCESS_CRASHED",
        `jiuwenswarm exited with code ${exit.code ?? exit.signal}`,
      );
    }
    const finalText = redactText(assembleText(deltas, final), secret);
    const resolvedUsage = usage ?? { inputTokens: null, outputTokens: null, totalTokens: null };
    const sessionRecord = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      exitCode: exit.code,
      usage: resolvedUsage,
      ...(stdoutText.truncated ? { truncated: true } : {}),
    };
    await session.appendFile(`${JSON.stringify(sessionRecord)}\n`, "utf8");
    await trajectory.append("usage", resolvedUsage);
    await trajectory.append("end", { status: "completed", finalText }, true);
    return { finalText, usage: resolvedUsage };
  } catch (error) {
    await requestStop();
    const settled = await Promise.allSettled([stdout, stderr, handle.done]);
    const settledStderr = settled[1]?.status === "fulfilled" ? settled[1].value : { text: "", truncated: false };
    const settledStdout = settled[0]?.status === "fulfilled" ? settled[0].value : { text: "", truncated: false };
    await writeFile(stderrPath, stderrEvidence(settledStderr, secret, limits.maxStderrBytes), {
      encoding: "utf8",
      mode: 0o600,
    });
    const failure = context.signal.aborted
      ? context.signal.reason ?? new DOMException("cancelled", "AbortError")
      : error;
    try {
      await trajectory.append(
        "error",
        {
          code: failure instanceof JiuwenswarmProtocolError || failure instanceof PhaseTimeoutError ||
            failure instanceof ModelOutputTruncatedError
            ? failure.code : "SOLVER_PROTOCOL_INVALID",
          message: redactText(errorMessage(failure), secret),
          ...(settledStdout.text.trim() ? { stdoutTail: redactText(settledStdout.text.trim(), secret).slice(0, 2000) } : {}),
        },
        true,
      );
    } catch {
      // The original process/protocol/cancellation failure stays authoritative.
    }
    throw failure;
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([session.close(), trajectory.close()]);
  }
}
