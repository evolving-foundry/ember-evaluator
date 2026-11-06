import { fetchNetworkResponse } from "../network/retry.js";
import { createHash } from "node:crypto";
import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import { expectRecord } from "../../core/validation/input.js";
import type { Usage } from "../../core/contracts/result.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";

export type TokenLogprob = { token: string; logprob: number };
export type ChatLogprobsParameters = { topLogprobs: number; thinking: "disabled" | "omit" };
export type ChatLogprobsEvidence = {
  schemaVersion: 1;
  protocol: "chat-logprobs-v1";
  model: string;
  promptSha256: string;
  finishReason: string;
  token: TokenLogprob;
  topLogprobs: TokenLogprob[];
  parameters: { maxTokens: 1; temperature: 0; topLogprobs: number; thinking: "disabled" | "omit" };
};

export function chatLogprobsEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new TypeError("choice-logprobs requires a credential-free HTTP(S) endpoint");
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path || "/v1"}/chat/completions`;
  return url.href;
}

export function tokenLogprob(value: unknown): TokenLogprob {
  const record = expectRecord(value, "Token logprob");
  if (typeof record.token !== "string" || !record.token || typeof record.logprob !== "number" || !Number.isFinite(record.logprob) || record.logprob > 0)
    throw new TypeError("Model service must return a nonempty token and a finite nonpositive logprob");
  return { token: record.token, logprob: record.logprob };
}

/** Single output position, retaining probabilities that generation-only SDKs discard. */
export async function requestChatLogprobs(model: ModelConfig, auth: RuntimeAuth, prompt: string,
  parameters: ChatLogprobsParameters, signal: AbortSignal): Promise<{ text: string; usage: Usage; evidence: ChatLogprobsEvidence }> {
  signal.throwIfAborted();
  if (model.endpoint === null || model.api !== "openai-completions")
    throw new TypeError("choice-logprobs requires an explicit OpenAI Chat Completions endpoint");
  const response = await fetchNetworkResponse(chatLogprobsEndpoint(model.endpoint), {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.value}` },
    body: JSON.stringify({ model: model.name, messages: [{ role: "user", content: prompt }],
      max_tokens: 1, temperature: 0, stream: false, logprobs: true, top_logprobs: parameters.topLogprobs,
      ...(parameters.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}) }),
  }, { context: { phase: "solve", component: "model" }, maxAttempts: model.retry?.maxAttempts ?? 4 });
  if (!response.ok) {
    const text = redactDiagnostic(await response.text(), [auth.value]).slice(0, 2000);
    const code = response.status === 401 || response.status === 403 ? "MODEL_AUTH_FAILED"
      : response.status === 429 ? "MODEL_RATE_LIMIT" : response.status >= 500 ? "MODEL_UNAVAILABLE" : "MODEL_REQUEST_INVALID";
    throw new EvaluatorError(code, `choice-logprobs HTTP ${response.status}: ${text}`);
  }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new TypeError("choice-logprobs requires a JSON Chat Completions response"); }
  signal.throwIfAborted();
  const data = expectRecord(value, "Chat Completions response");
  if (!Array.isArray(data.choices) || data.choices.length !== 1) throw new TypeError("choice-logprobs requires one returned choice");
  const choice = expectRecord(data.choices[0], "Chat choice");
  const message = expectRecord(choice.message, "Chat message");
  const usage = data.usage === undefined ? {} : expectRecord(data.usage, "Chat usage");
  const completionDetails = usage.completion_tokens_details === undefined ? {} : expectRecord(usage.completion_tokens_details, "Completion token details");
  if ((typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) ||
    (typeof completionDetails.reasoning_tokens === "number" && completionDetails.reasoning_tokens > 0))
    throw new TypeError("choice-logprobs received reasoning tokens; disable thinking to score the answer position");
  if (typeof message.content !== "string" || !message.content || !["stop", "length"].includes(String(choice.finish_reason)))
    throw new TypeError("choice-logprobs received no valid answer token");
  const logprobs = expectRecord(choice.logprobs, "Model service must provide choices[0].logprobs");
  if (!Array.isArray(logprobs.content) || logprobs.content.length !== 1)
    throw new TypeError("Model service must provide logprobs.content for exactly one answer token");
  const first = expectRecord(logprobs.content[0], "Answer token probabilities");
  if (!Array.isArray(first.top_logprobs) || !first.top_logprobs.length)
    throw new TypeError("Model service must provide nonempty top_logprobs; generated text alone cannot score MMLU");
  const count = (key: string): number | null => {
    const value = usage[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid Chat usage ${key}`);
    return value;
  };
  return { text: message.content,
    usage: { inputTokens: count("prompt_tokens"), outputTokens: count("completion_tokens"), totalTokens: count("total_tokens") },
    evidence: { schemaVersion: 1, protocol: "chat-logprobs-v1", model: typeof data.model === "string" ? data.model : model.name,
      promptSha256: createHash("sha256").update(prompt).digest("hex"), finishReason: String(choice.finish_reason),
      token: tokenLogprob(first), topLogprobs: first.top_logprobs.map(tokenLogprob),
      parameters: { maxTokens: 1, temperature: 0, topLogprobs: parameters.topLogprobs, thinking: parameters.thinking } } };
}
