/** Adapt Evaluator trajectory events and result.json into the Collector's step/outcome model. */
import { round } from "./num.js";

const TEXT_LIMIT = 2000;
const OBSERVATION_LIMIT = 4000;

const LLM_FUNCTION = "llm.call";
const AGENT_FUNCTION = "agent.run";

type Obj = Record<string, unknown>;
type Step = Record<string, unknown> & {
  step_id: string;
  extra: { ancestry: Obj; invocation: Obj };
  observation?: { content: string };
};

/** ISO8601 -> epoch seconds; returns null if parsing fails. */
function sec(at: unknown): number | null {
  if (typeof at !== "string" || !at) return null;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

function clip(text: unknown, limit: number): string {
  if (typeof text !== "string") return "";
  if (limit > 0 && text.length > limit) return `${text.slice(0, limit)}…(truncated)`;
  return text;
}

function num(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return value;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

/** Extract plain text from pi's content array, ignoring blocks such as thinking. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item !== null && typeof item === "object" && (item as Obj).type === "text") {
      const text = (item as Obj).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Extract toolCall blocks from an assistant message's content. */
function toolCallsOf(content: unknown): Obj[] {
  if (!Array.isArray(content)) return [];
  const calls: Obj[] = [];
  for (const item of content) {
    if (item !== null && typeof item === "object" && (item as Obj).type === "toolCall") {
      const call = item as Obj;
      calls.push({ id: call.id, function_name: call.name, arguments: call.arguments });
    }
  }
  return calls;
}

interface StepOptions {
  timestamp?: unknown;
  status?: string;
  error?: string | null;
  metrics?: Obj | null;
  toolCalls?: Obj[] | null;
  observation?: string | null;
  parentId?: unknown;
  modelName?: string | null;
}

function makeStep(
  index: number,
  source: string,
  fn: string,
  message: string,
  start: number | null = null,
  end: number | null = null,
  options: StepOptions = {},
): Step {
  const step: Record<string, unknown> = { step_id: `s${index}`, source, message };
  if (options.timestamp) step.timestamp = options.timestamp;
  if (options.metrics) step.metrics = options.metrics;
  if (options.toolCalls) step.tool_calls = options.toolCalls;
  if (options.observation !== undefined && options.observation !== null) {
    step.observation = { content: options.observation };
  }
  if (options.modelName) step.model_name = options.modelName;
  const invocation: Obj = { status: options.status ?? "ok" };
  if (start !== null) invocation.start_timestamp = round(start, 6);
  if (end !== null) invocation.end_timestamp = round(end, 6);
  if (options.error !== undefined && options.error !== null) invocation.error = options.error;
  step.extra = {
    ancestry: { function_id: `f${index}`, function_name: fn, parent_id: options.parentId ?? null },
    invocation,
  };
  return step as Step;
}

type Meta = {
  run_id: unknown;
  task_id: unknown;
  attempt_id: unknown;
  status: string;
  usage: Obj | null;
  error: unknown;
  final_text: unknown;
  model: string | null;
  prompt: unknown;
  system: string | null;
};

/**
 * Rebuild a single attempt's event stream into an ATIF-style payload.
 *
 * Returns a payload holding schema_version / session_id / steps plus meta such as
 * run_id, task_id, attempt_id, status, usage, error and final_text.
 */
export function stepsFromEvents(
  events: unknown[],
  options: { textLimit?: number; observationLimit?: number } = {},
): Obj {
  const textLimit = options.textLimit ?? TEXT_LIMIT;
  const observationLimit = options.observationLimit ?? OBSERVATION_LIMIT;
  const rows = (events ?? []).filter(
    (event): event is Obj => event !== null && typeof event === "object" && typeof (event as Obj).type === "string",
  );
  rows.sort((a, b) => (num(a.seq) ?? 0) - (num(b.seq) ?? 0));

  const steps: Step[] = [];
  const meta: Meta = {
    run_id: null,
    task_id: null,
    attempt_id: null,
    status: "incomplete",
    usage: null,
    error: null,
    final_text: null,
    model: null,
    prompt: null,
    system: null,
  };
  // Trajectory bounds come from the first and last at of the stream: runs like agentx
  // only emit start/end and have no steps, yet the UI still needs an attempt timeline.
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  const pending = new Map<unknown, number>();
  const llmStepOf = new Map<unknown, string>();
  let prevAt: number | null = null;

  for (const row of rows) {
    const typ = row.type;
    const data = asObject(row.data);
    const at = sec(row.at);

    const key = row.key;
    if (key !== null && typeof key === "object" && !Array.isArray(key)) {
      for (const [field, name] of [
        ["runId", "run_id"],
        ["taskId", "task_id"],
        ["attemptId", "attempt_id"],
      ] as const) {
        const value = (key as Obj)[field];
        if (meta[name] === null && value !== null && value !== undefined) meta[name] = value;
      }
    }

    if (typ === "start") {
      const input = data.input;
      if (input !== null && typeof input === "object" && !Array.isArray(input)) {
        meta.prompt = (input as Obj).prompt;
        if (meta.task_id === null) meta.task_id = (input as Obj).id;
      }
    } else if (typ === "message") {
      const role = data.role;
      const content = data.content;
      if (role === "system") {
        // The system prompt is large and repeats every turn: keep it in meta only, no step.
        const sections = asObject(data.sections);
        meta.system = clip(
          textOf(content) || (typeof sections.preamble === "string" ? sections.preamble : ""),
          textLimit,
        );
      } else if (role === "user") {
        steps.push(
          makeStep(steps.length + 1, "user", "user.input", clip(textOf(content), textLimit), at, at, {
            timestamp: row.at,
          }),
        );
      } else if (role === "assistant") {
        const duration = num(data.durationMs);
        const durationS = duration !== null && duration >= 0 ? duration / 1000 : null;
        // Message events are flushed after the response completes, so at is the end;
        // derive the start from it.
        const end = at;
        const start = at !== null && durationS !== null ? at - durationS : at;
        const usage = asObject(data.usage);
        const metrics: Obj = {};
        const promptTokens = num(usage.input);
        const completionTokens = num(usage.output);
        // cacheRead is a separate field and must not be folded into input,
        // otherwise cache reuse is invisible.
        const cachedTokens = num(usage.cacheRead);
        if (promptTokens !== null) metrics.prompt_tokens = Math.trunc(promptTokens);
        if (completionTokens !== null) metrics.completion_tokens = Math.trunc(completionTokens);
        if (cachedTokens !== null) metrics.cached_tokens = Math.trunc(cachedTokens);
        const model = data.model || data.responseModel;
        const calls = toolCallsOf(content);
        const step = makeStep(
          steps.length + 1,
          "agent",
          LLM_FUNCTION,
          clip(textOf(content), textLimit),
          start,
          end,
          {
            timestamp: row.at,
            metrics: Object.keys(metrics).length > 0 ? metrics : null,
            toolCalls: calls.length > 0 ? calls : null,
            modelName: typeof model === "string" ? model : null,
          },
        );
        steps.push(step);
        if (meta.model === null && typeof model === "string") meta.model = model;
        for (const call of calls) {
          if (call.id !== undefined && call.id !== null) llmStepOf.set(call.id, step.step_id);
        }
      }
      // role == "toolResult" duplicates the tool_result event, skip it.
    } else if (typ === "tool_start") {
      const callId = data.id;
      const name = data.name || "tool";
      const index = steps.length + 1;
      steps.push(
        makeStep(index, "system", String(name), "", at, null, {
          timestamp: row.at,
          status: "incomplete",
          parentId: llmStepOf.get(callId) ?? null,
        }),
      );
      if (callId !== undefined && callId !== null) pending.set(callId, index - 1);
    } else if (typ === "tool_result") {
      const callId = data.id;
      const name = data.name || "tool";
      const result = asObject(data.result);
      const text = clip(textOf(result.content), observationLimit);
      const failed = data.isError === true;
      const index = pending.get(callId);
      pending.delete(callId);
      if (index === undefined) {
        // No matching tool_start (truncated trace or lost event): synthesize a full step.
        steps.push(
          makeStep(steps.length + 1, "system", String(name), "", at, at, {
            timestamp: row.at,
            status: failed ? "error" : "ok",
            error: failed ? text : null,
            observation: text,
            parentId: llmStepOf.get(callId) ?? null,
          }),
        );
      } else {
        const step = steps[index]!;
        const invocation = step.extra.invocation;
        invocation.status = failed ? "error" : "ok";
        if (at !== null) invocation.end_timestamp = round(at, 6);
        if (failed) invocation.error = text;
        step.observation = { content: text };
      }
    } else if (typ === "error") {
      let message = data.message;
      if (typeof message !== "string" || !message) message = data.name || "error";
      steps.push(
        makeStep(
          steps.length + 1,
          "agent",
          AGENT_FUNCTION,
          clip(message, textLimit),
          prevAt !== null ? prevAt : at,
          at,
          { timestamp: row.at, status: "error", error: String(message) },
        ),
      );
      meta.error = { name: data.name, message: data.message };
      meta.status = "failed";
    } else if (typ === "usage") {
      meta.usage = {
        input_tokens: data.inputTokens,
        output_tokens: data.outputTokens,
        total_tokens: data.totalTokens,
      };
    } else if (typ === "end") {
      const status = data.status;
      meta.status = typeof status === "string" && status ? status : "completed";
      meta.final_text = data.finalText;
    }
    // agent_end is the Agent-layer retry boundary and produces no step.

    if (at !== null) {
      if (firstAt === null) firstAt = at;
      lastAt = at;
      prevAt = at;
    }
  }

  // tool_start without tool_result: keep the half-open interval and mark it incomplete.
  for (const index of [...pending.values()].sort((a, b) => a - b)) {
    steps[index]!.extra.invocation.status = "incomplete";
  }

  steps.forEach((step, index) => {
    step.step_id = `s${index + 1}`;
  });

  // The header stats read final_metrics: without them the token column would keep
  // showing "-" even though the data is spread across each step's metrics.
  const totals: Record<string, number> = { total_steps: steps.length };
  let seenTokens = false;
  for (const step of steps) {
    const metrics = asObject(step.metrics);
    for (const [key, name] of [
      ["prompt_tokens", "total_prompt_tokens"],
      ["completion_tokens", "total_completion_tokens"],
      ["cached_tokens", "total_cached_tokens"],
    ] as const) {
      const value = metrics[key];
      if (typeof value === "number" && Number.isInteger(value)) {
        totals[name] = (totals[name] ?? 0) + value;
        seenTokens = true;
      }
    }
  }
  if (!seenTokens) {
    const usage = asObject(meta.usage);
    if (typeof usage.input_tokens === "number" && Number.isInteger(usage.input_tokens)) {
      totals.total_prompt_tokens = usage.input_tokens;
    }
    if (typeof usage.output_tokens === "number" && Number.isInteger(usage.output_tokens)) {
      totals.total_completion_tokens = usage.output_tokens;
    }
  }

  return {
    schema_version: "ATIF-v1.7",
    session_id: meta.attempt_id,
    trajectory_id: meta.attempt_id,
    // name is for list rendering, model_name for the header bar; missing either shows "model -".
    agent: { name: meta.model || "evaluator", model_name: meta.model },
    run_id: meta.run_id,
    task_id: meta.task_id,
    attempt_id: meta.attempt_id,
    status: meta.status,
    started_at: firstAt,
    ended_at: lastAt,
    prompt: meta.prompt,
    system_prompt: meta.system,
    final_text: meta.final_text,
    usage: meta.usage,
    error: meta.error,
    final_metrics: totals,
    steps,
  };
}

/**
 * Map the Evaluator's result.json onto the Collector's outcome record.
 *
 * Field mapping:
 *   key.taskId -> task_id
 *   verdict.passed -> success (an agent_timeout with a null verdict counts as failure)
 *   verdict.score -> reward (left empty when unavailable, never assumed 0)
 *   accounting.cost -> cost_usd
 *   executionStatus -> status (stored with the record, not used in aggregation)
 *
 * Note: durationMs is deliberately not written into latency_ms. It is the wall-clock
 * time of the whole task, including container setup, while latency.* thresholds are
 * defined for inference latency; filling it in would keep that signal permanently lit.
 */
export function outcomeFromResult(result: unknown): Obj | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Obj;
  const key = asObject(record.key);
  const verdict = asObject(record.verdict);
  const details = verdict.details !== undefined && verdict.details !== null ? asObject(verdict.details) : null;
  const accounting = asObject(record.accounting);
  const usage = accounting.usage !== undefined && accounting.usage !== null ? asObject(accounting.usage) : null;
  return {
    kind: "outcome",
    run_id: key.runId,
    attempt_id: key.attemptId,
    task_id: String(key.taskId ?? record.taskId ?? ""),
    success: Boolean(verdict.passed),
    reward: num(verdict.score),
    cost_usd: num(accounting.cost),
    // When no price table exists cost stays 0, so token usage is the usable magnitude.
    tokens: usage,
    status: record.executionStatus,
    // Scoring details (extracted / method etc.) let the analysis layer tell a wrong
    // model answer apart from a scorer that failed to recognize it.
    verdict_details: details,
  };
}
