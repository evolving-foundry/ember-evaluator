import { classifyError } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api } from "@earendil-works/pi-ai";
import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import { streamWithProviderOutput } from "./openai-output.js";

/** Transport only. Benchmark definitions own prompts, parsing and scoring. */
export async function completeJudge(prompt: string, config: ModelConfig, auth: RuntimeAuth, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  let providerId: string;
  if (config.endpoint !== null) {
    if (config.api === null) throw new TypeError("Judge endpoint requires an API protocol");
    providerId = "ember-judge";
    runtime.registerProvider(providerId, {
      name: "Ember judge provider",
      baseUrl: config.endpoint,
      api: config.api as Api,
      ...(config.api === "openai-completions" && config.maxTokens === undefined
        ? { streamSimple: streamWithProviderOutput } : {}),
      models: [
        {
          id: config.name,
          name: config.name,
          api: config.api as Api,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          // SDK catalog metadata only; the unset custom Chat Completions wire limit is removed above.
          maxTokens: config.maxTokens ?? 8_192,
        },
      ],
    });
  } else {
    if (config.provider === null) throw new TypeError("Judge provider is required");
    providerId = config.provider;
  }
  await runtime.setRuntimeApiKey(providerId, auth.value);
  const model = runtime.getModel(providerId, config.name);
  if (!model) throw new Error(`Judge model ${providerId}/${config.name} is unavailable`);
  const result = await runtime.completeSimple(
    model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    { signal, apiKey: auth.value, maxRetries: (config.retry?.maxAttempts ?? 4) - 1, ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }) },
  );
  signal.throwIfAborted();
  if (result.stopReason === "error") {
    const message = result.errorMessage ?? "Judge model request failed";
    const status = /^([45]\d\d)(?::|\s)/u.exec(message)?.[1];
    const error = Object.assign(new Error(message), {
      ...(status ? { status: Number(status) } : {}),
      ...(message === "Connection error." ? { name: "APIConnectionError" } : {}),
      ...(message === "Request timed out." ? { name: "APITimeoutError" } : {}),
    });
    const failure = classifyError(error, { phase: "verify", component: "model", secrets: [auth.value] });
    throw new EvaluatorError(failure.code, failure.message, failure.details);
  }
  if (result.stopReason !== "stop") throw new Error(`Judge model stopped with ${result.stopReason}`);
  const text = result.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("");
  return text;
}
