import type { ErrorCode } from "../../core/errors/registry.js";
import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import type { EnvironmentSession, ProcessHandle } from "../../core/contracts/environment.js";
import type { FileEntry, SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { inspectFile } from "../../core/artifacts/artifacts.js";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { LIVE_LINES, safeLiveText, toolActivity } from "../../core/progress/live-progress.js";

type JsonRecord = { [key: string]: JsonValue };
type DshAttemptContext = AttemptContext & { environment?: EnvironmentSession };

async function inspectToolOutput(context: DshAttemptContext, reference: string): Promise<FileEntry> {
  try {
    return await inspectFile(context.paths.root, reference);
  } catch (error) {
    // Non-root container exports retain 0700/0600 until quiescence. Read that
    // private file through its environment instead of weakening permissions or
    // requiring the solver user to chown files to the coordinator's host UID.
    if (context.environment?.runtime?.persistent !== false ||
        !error || typeof error !== "object" || !("code" in error) ||
        (error.code !== "EACCES" && error.code !== "EPERM")) throw error;
  }
  const staging = await mkdtemp(join(tmpdir(), "evaluator-dsh-tool-output-"));
  try {
    const source = posix.join(context.environment.agentOutputDir, reference.slice("agent/".length));
    await context.environment.download(source, join(staging, "output"), context.signal);
    return await inspectFile(staging, "output");
  } finally { await rm(staging, { recursive: true, force: true }); }
}

type StepUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type DshProtocolLimits = {
  maxRecordBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
};

const DEFAULT_LIMITS: DshProtocolLimits = {
  maxRecordBytes: 8 * 1024 * 1024,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
};

class DshProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DshProtocolError";
  }
}

function malformed(label: string, message: string, options?: ErrorOptions): DshProtocolError {
  return new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${label} ${message}`, options);
}

function outputLimit(label: string, message: string): DshProtocolError {
  return new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${label} ${message}`);
}

function validatedLimits(value: DshProtocolLimits): DshProtocolLimits {
  const limits = { ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const result = Object.create(null) as JsonRecord;
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, `${path}.${key}`);
    return result;
  }
  throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${path} is not a JSON value`);
}

function record(value: JsonValue | undefined, path: string): JsonRecord {
  if (value === undefined || !isRecord(value))
    throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${path} must be an object`);
  return value;
}

function string(value: JsonValue | undefined, path: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && value.trim() === "")) {
    throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${path} must be ${nonempty ? "a non-empty " : "a "}string`);
  }
  return value;
}

function integer(value: JsonValue | undefined, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${path} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function optionalToken(value: JsonValue | undefined, path: string): number | undefined {
  return value === undefined ? undefined : integer(value, path, 0);
}

function parseUsage(value: JsonValue | undefined): StepUsage | undefined {
  if (value === undefined) return undefined;
  const usage = record(value, "status.usage");
  const totalTokens = optionalToken(usage.totalTokens, "status.usage.totalTokens");
  const cacheReadTokens = optionalToken(usage.cacheReadTokens, "status.usage.cacheReadTokens");
  const cacheWriteTokens = optionalToken(usage.cacheWriteTokens, "status.usage.cacheWriteTokens");
  return {
    inputTokens: integer(usage.inputTokens, "status.usage.inputTokens", 0),
    outputTokens: integer(usage.outputTokens, "status.usage.outputTokens", 0),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function redactText(value: string, secret: string): string {
  if (secret === "") return value;
  for (const sensitive of new Set([secret, encodeURIComponent(secret)])) {
    value = value.replaceAll(sensitive, "[redacted]");
  }
  return value;
}

function redact(value: JsonValue, secret: string): JsonValue {
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (!isRecord(value)) return value;
  const result = Object.create(null) as JsonRecord;
  for (const [key, item] of Object.entries(value)) {
    result[redactText(key, secret)] = redact(item, secret);
  }
  return result;
}

function eventData(event: JsonRecord, secret: string): JsonRecord {
  const data = Object.create(null) as JsonRecord;
  for (const [key, value] of Object.entries(event)) {
    if (key !== "type") data[redactText(key, secret)] = redact(value, secret);
  }
  return data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class DshStreamState {
  private sessionSeen = false;
  private activeTurn: number | null = null;
  private activeStep: number | null = null;
  private lastReason: JsonRecord | null = null;
  private finalText: string | null = null;
  private completedSteps = 0;
  private incompleteUsage = false;
  private nextTurn = 1;
  private nextStep = 1;
  private readonly pendingCalls = new Set<string>();
  private readonly usages: StepUsage[] = [];

  constructor(
    private readonly trajectory: TrajectoryWriter,
    private readonly secret: string,
    private readonly label: string,
    private readonly inspectOutput: (reference: string) => Promise<FileEntry>,
    private readonly activity?: ActivityListener,
  ) {}

  async accept(value: JsonValue, index: number): Promise<void> {
    if (!isRecord(value)) throw malformed(this.label, `record ${index} must be an object`);
    const type = string(value.type, `record ${index}.type`, true);
    if (!this.sessionSeen) {
      if (type !== "session") throw malformed(this.label, "stream must open with the session record");
      await this.session(value);
      return;
    }
    if (type === "session") throw malformed(this.label, "stream contains more than one session record");
    if (this.finalText !== null) throw malformed(this.label, "stream contains a record after final");

    switch (type) {
      case "status":
        await this.status(value);
        this.activity?.({ message: "Agent execution step updated" });
        return;
      case "thinking":
      case "text":
        this.requireActiveStep(type);
        string(value.text, `${type}.text`);
        await this.trajectory.append(type, eventData(value, this.secret));
        this.activity?.({ message: "Receiving model response" });
        return;
      case "tool_call":
        this.requireActiveStep(type);
        {
          const callId = string(value.callId, "tool_call.callId", true);
          if (this.pendingCalls.has(callId)) throw malformed(this.label, `duplicate tool_call ${callId}`);
          this.pendingCalls.add(callId);
        }
        string(value.tool, "tool_call.tool", true);
        if (value.input === undefined) throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", "tool_call.input is required");
        await this.trajectory.append(type, eventData(value, this.secret));
        this.activity?.({ message: "Running tool", lines: [safeLiveText(toolActivity(String(value.tool), value.input), [this.secret])] });
        return;
      case "tool_result": {
        this.requireActiveStep(type);
        const callId = string(value.callId, "tool_result.callId", true);
        if (!this.pendingCalls.delete(callId))
          throw malformed(this.label, `tool_result ${callId} has no pending tool_call`);
        if (value.status !== "completed" && value.status !== "error") {
          throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", "tool_result.status must be completed or error");
        }
        string(value.result, "tool_result.result");
        await this.toolOutput(value);
        await this.trajectory.append(type, eventData(value, this.secret));
        this.activity?.({ message: "Tool result received", lines: String(value.result).split(/\r?\n/u).slice(-LIVE_LINES).map(line => safeLiveText(line, [this.secret])) });
        return;
      }
      case "final":
        // DSH can open the next turn while handing its completed answer to
        // headless mode. Permit that empty trailer only after a completed turn.
        if (this.label === "DSH" && this.activeTurn !== null && this.activeStep === null
          && this.nextStep === 1 && this.lastReason?.kind === "completed") this.activeTurn = null;
        if (this.activeTurn !== null || this.activeStep !== null || this.lastReason === null) {
          throw malformed(this.label, "final must follow a completed turn_end status");
        }
        this.finalText = string(value.text, "final.text");
        return;
      case "error": {
        const message = string(value.message, "error.message", true);
        throw new DshProtocolError(
          "INTERNAL_ERROR",
          `${this.label} reported an error: ${redactText(message, this.secret)}`,
        );
      }
      default:
        await this.trajectory.append("event", redact(value, this.secret));
    }
  }

  private async toolOutput(value: JsonRecord): Promise<void> {
    const hasReference = ["resultRef", "originalBytes", "storedBytes", "sha256"].some(key => value[key] !== undefined);
    if (!hasReference) {
      if (this.label === "DSH" && value.truncated === true)
        throw malformed(this.label, "truncated tool_result must reference its complete output file");
      return;
    }
    const reference = string(value.resultRef, "tool_result.resultRef", true);
    if (!/^agent\/tool-outputs\/[a-zA-Z0-9_-]{1,128}\.txt$/u.test(reference))
      throw malformed(this.label, "tool_result.resultRef must name a file under agent/tool-outputs");
    if (value.truncated !== true) throw malformed(this.label, "tool_result with resultRef must mark its preview truncated");
    const originalBytes = integer(value.originalBytes, "tool_result.originalBytes", 0);
    const storedBytes = value.storedBytes === undefined ? originalBytes : integer(value.storedBytes, "tool_result.storedBytes", 0);
    const digest = string(value.sha256, "tool_result.sha256", true);
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw malformed(this.label, "tool_result.sha256 must be a SHA256 hex digest");
    try {
      const actual = await this.inspectOutput(reference);
      if (actual.size !== storedBytes || actual.sha256 !== digest)
        throw new Error("tool output size or SHA256 does not match the event");
    } catch (cause) {
      throw malformed(this.label, `Cannot verify complete tool output ${reference}`, { cause });
    }
  }

  private async session(value: JsonRecord): Promise<void> {
    string(value.sessionId, "session.sessionId", true);
    string(value.cwd, "session.cwd", true);
    this.sessionSeen = true;
    await this.trajectory.append("start", eventData(value, this.secret), true);
  }

  private async status(value: JsonRecord): Promise<void> {
    const phase = string(value.phase, "status.phase", true);
    const turn = integer(value.turn, "status.turn", 1);
    if (phase === "turn_start") {
      if (this.activeTurn !== null || this.activeStep !== null) {
        throw malformed(this.label, "turn_start cannot occur while a turn or step is active");
      }
      if (turn !== this.nextTurn)
        throw malformed(this.label, `turn_start expected turn ${this.nextTurn}, received ${turn}`);
      this.activeTurn = turn;
      this.nextStep = 1;
    } else if (phase === "step_start") {
      this.requireTurn(turn, "step_start");
      this.lastReason = null;
      if (this.activeStep !== null) throw malformed(this.label, "step_start cannot occur while another step is active");
      const step = integer(value.step, "status.step", 1);
      if (step !== this.nextStep)
        throw malformed(this.label, `step_start expected step ${this.nextStep}, received ${step}`);
      this.activeStep = step;
    } else if (phase === "step_end") {
      this.requireTurn(turn, "step_end");
      const step = integer(value.step, "status.step", 1);
      if (this.activeStep === null || step !== this.activeStep) {
        throw malformed(this.label, "step_end does not match the active step");
      }
      if (this.pendingCalls.size !== 0)
        throw malformed(this.label, "step_end cannot occur while tool calls remain pending");
      this.completedSteps += 1;
      const usage = parseUsage(value.usage);
      if (usage === undefined) this.incompleteUsage = true;
      else this.usages.push(usage);
      this.activeStep = null;
      this.nextStep += 1;
    } else if (phase === "turn_end") {
      this.requireTurn(turn, "turn_end");
      if (this.activeStep !== null) throw malformed(this.label, "turn_end cannot occur while a step is active");
      const reason = record(value.reason, "status.reason");
      string(reason.kind, "status.reason.kind", true);
      this.lastReason = reason;
      this.activeTurn = null;
      this.nextTurn += 1;
    } else {
      throw malformed(this.label, `unrecognized status phase ${phase}`);
    }
    await this.trajectory.append("status", eventData(value, this.secret));
  }

  private requireTurn(turn: number, phase: string): void {
    if (this.activeTurn === null || turn !== this.activeTurn) {
      throw malformed(this.label, `${phase} does not match the active turn`);
    }
  }

  private requireActiveStep(type: string): void {
    if (this.activeTurn === null || this.activeStep === null) {
      throw malformed(this.label, `${type} must occur while a step is active`);
    }
  }

  finish(exit: { code: number | null; signal: string | null }): SolveResult {
    if (
      !this.sessionSeen ||
      this.activeTurn !== null ||
      this.activeStep !== null ||
      this.lastReason === null
    ) {
      if (exit.code !== 0 || exit.signal !== null) {
        throw new DshProtocolError("SOLVER_PROCESS_CRASHED",
          `${this.label} exited with code ${String(exit.code)} and signal ${String(exit.signal)} before completing its stream`);
      }
      throw malformed(this.label, "stream ended before a complete turn and unique final record");
    }
    if (this.lastReason.kind !== "completed" && this.lastReason.kind !== "max-tokens") {
      const detail = this.lastReason.error;
      const diagnostic = detail !== undefined && isRecord(detail) && typeof detail.message === "string"
        ? redactText(detail.message, this.secret)
        : null;
      throw new DshProtocolError(
        "SOLVER_RESULT_INCOMPLETE",
        `${this.label} turn ended with reason ${String(this.lastReason.kind)}`,
        diagnostic === null ? undefined : { cause: new Error(diagnostic) },
      );
    }
    if (this.finalText === null) throw malformed(this.label, "stream ended before a complete turn and unique final record");
    // DSH 0.1.6-alpha.2 exits 1 for every non-completed turn, including max-tokens.
    const truncatedExit = this.label === "DSH" && this.lastReason.kind === "max-tokens" && exit.code === 1;
    if ((exit.code !== 0 && !truncatedExit) || exit.signal !== null) {
      throw new DshProtocolError(
        "SOLVER_PROCESS_CRASHED",
        `${this.label} exited with code ${String(exit.code)} and signal ${String(exit.signal)}`,
      );
    }
    return { finalText: redactText(this.finalText, this.secret), usage: this.usage() };
  }

  reason(): JsonValue {
    return this.lastReason === null ? null : redact(this.lastReason, this.secret);
  }

  private usage(): Usage {
    if (this.completedSteps === 0 || this.incompleteUsage || this.usages.length !== this.completedSteps) {
      return { inputTokens: null, outputTokens: null, totalTokens: null };
    }
    const allCacheKnown = this.usages.every(
      usage => usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined,
    );
    const inputTokens = allCacheKnown
      ? this.usages.reduce(
          (sum, usage) => sum + usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          0,
        )
      : null;
    const outputTokens = this.usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
    const allTotalsKnown = this.usages.every(usage => usage.totalTokens !== undefined);
    const totalTokens = allTotalsKnown
      ? this.usages.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0)
      : inputTokens === null
        ? null
        : inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens };
  }
}

async function consumeLines(
  source: AsyncIterable<Uint8Array>,
  session: FileHandle,
  state: DshStreamState,
  secret: string,
  limits: DshProtocolLimits,
  label: string,
): Promise<void> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let totalBytes = 0;
  let index = 0;
  const accept = async (line: string): Promise<void> => {
    if (line.trim() === "") throw malformed(label, "stdout contains an empty record");
    let parsed: JsonValue;
    try {
      const unknownParsed: unknown = JSON.parse(line);
      parsed = jsonValue(unknownParsed, `${label} stdout record ${index + 1}`);
    } catch (error) {
      if (error instanceof DshProtocolError) throw error;
      throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${label} stdout record ${index + 1} is not valid JSON`, {
        cause: error,
      });
    }
    index += 1;
    await session.appendFile(`${JSON.stringify(redact(parsed, secret))}\n`, "utf8");
    await state.accept(parsed, index);
  };

  const append = (value: Uint8Array): void => {
    if (value.byteLength === 0) return;
    pendingBytes += value.byteLength;
    if (pendingBytes > limits.maxRecordBytes) {
      throw outputLimit(label, `stdout record exceeded ${limits.maxRecordBytes} bytes`);
    }
    pending.push(Buffer.from(value));
  };

  for await (const chunk of source) {
    totalBytes += chunk.byteLength;
    if (totalBytes > limits.maxStdoutBytes) {
      throw outputLimit(label, `stdout exceeded ${limits.maxStdoutBytes} bytes`);
    }
    const bytes = Buffer.from(chunk);
    let offset = 0;
    let newline = bytes.indexOf(0x0a, offset);
    while (newline !== -1) {
      append(bytes.subarray(offset, newline));
      const recordBytes = Buffer.concat(pending, pendingBytes);
      const end = recordBytes.at(-1) === 0x0d ? recordBytes.length - 1 : recordBytes.length;
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(recordBytes.subarray(0, end));
      } catch (cause) {
        throw new DshProtocolError("SOLVER_PROTOCOL_INVALID", `${label} stdout record ${index + 1} is not valid UTF-8`, {
          cause,
        });
      }
      pending = [];
      pendingBytes = 0;
      await accept(line);
      offset = newline + 1;
      newline = bytes.indexOf(0x0a, offset);
    }
    append(bytes.subarray(offset));
  }
  if (pendingBytes !== 0) throw malformed(label, "stdout ended with an unterminated JSON record");
  await session.sync();
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
 * Consume the newline-delimited evaluator harness event stream and persist
 * native and unified evidence. The wire shape is shared: the DSH runtime
 * emits it natively in alpha.2, and the deepagents runner replays LangGraph
 * state onto the same events. `label` scopes error codes (DSH_*, DEEPAGENTS_*).
 */
export async function consumeDsh(
  handle: ProcessHandle,
  context: DshAttemptContext,
  secret: string,
  limits: DshProtocolLimits = DEFAULT_LIMITS,
  label = "DSH",
): Promise<SolveResult> {
  limits = validatedLimits(limits);
  const sessionPath = join(context.paths.agent, "session.jsonl");
  const stderrPath = join(context.paths.agent, "stderr.log");
  const trajectory = new TrajectoryWriter(join(context.paths.agent, "trajectory.jsonl"), context.key);
  let session: FileHandle;
  try {
    session = await open(sessionPath, "a", 0o600);
  } catch (error) {
    await Promise.allSettled([handle.stop(100), trajectory.close()]);
    throw error;
  }
  const state = new DshStreamState(trajectory, secret, label, reference => inspectToolOutput(context, reference), context.activity);
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

  const stdout = consumeLines(handle.stdout, session, state, secret, limits, label);
  const stderr = collectText(handle.stderr, limits.maxStderrBytes);
  try {
    const [exit, stderrText] = await Promise.all([handle.done, stderr, stdout]);
    await writeFile(stderrPath, stderrEvidence(stderrText, secret, limits.maxStderrBytes), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (context.signal.aborted) throw context.signal.reason ?? new DOMException("cancelled", "AbortError");
    const result = state.finish(exit);
    const reason = state.reason();
    if (reason !== null && isRecord(reason) && reason.kind === "max-tokens") {
      const warning = { code: "SOLVER_OUTPUT_LIMIT" as const,
        message: `${label} model output was truncated (reason=max-tokens); continuing evaluation with the actual output.` };
      context.warning?.(warning);
      await trajectory.append("warning", warning);
    }
    await trajectory.append("usage", result.usage);
    await trajectory.append("end", { status: "completed", finalText: result.finalText, reason: state.reason() }, true);
    return result;
  } catch (error) {
    await requestStop();
    const settled = await Promise.allSettled([stdout, stderr, handle.done]);
    const stderrText = settled[1]?.status === "fulfilled" ? settled[1].value : { text: "", truncated: false };
    const exit = settled[2]?.status === "fulfilled" ? settled[2].value : null;
    await writeFile(stderrPath, stderrEvidence(stderrText, secret, limits.maxStderrBytes), {
      encoding: "utf8",
      mode: 0o600,
    });
    const failure = context.signal.aborted
      ? (context.signal.reason ?? new DOMException("cancelled", "AbortError"))
      : error;
    try {
      await trajectory.append(
        "error",
        {
          code: context.signal.aborted
            ? `${label}_${failure instanceof Error && failure.name === "TimeoutError" ? "TIMEOUT" : "RUN_CANCELLED"}`
            : failure instanceof DshProtocolError ? failure.code : `${label}_PROTOCOL_FAILURE`,
          message: redactText(errorMessage(failure), secret),
          exit,
        },
        true,
      );
    } catch {
      // The original process/protocol failure remains authoritative.
    }
    throw failure;
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    await Promise.allSettled([session.close(), trajectory.close()]);
  }
}
