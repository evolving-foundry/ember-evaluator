import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api } from "@earendil-works/pi-ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";

export async function createHarnessModel(config: ModelConfig, auth: RuntimeAuth, directory?: string) {
  const options = { credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false };
  const runtime = await ModelRuntime.create(options);
  let provider = config.provider;
  let knownContext = true;
  if (config.endpoint !== null) {
    if (config.api === null) throw new TypeError("An explicit endpoint requires an API protocol");
    const matches = runtime.getModels().filter(model => model.id === config.name);
    const uniqueMatch = matches.length === 1 ? matches[0] : undefined;
    const registered = provider === null ? uniqueMatch : runtime.getModel(provider, config.name);
    knownContext = registered !== undefined;
    provider = "ember-runtime";
    let definition = registered;
    if (definition === undefined) {
      // Let the Harness construct its own unknown-model definition. No Evaluator
      // output budget or context size is supplied, and its fallback window is
      // not treated as authoritative metadata by our compaction policy.
      const modelDirectory = directory ?? await mkdtemp(join(tmpdir(), "evaluator-model-"));
      try {
        const path = join(modelDirectory, "model-config.json");
        await writeFile(path, JSON.stringify({ providers: { [provider]: {
          baseUrl: config.endpoint, api: config.api, models: [{ id: config.name }],
        } } }) + "\n", { mode: 0o600 });
        const fallback = await ModelRuntime.create({ ...options, modelsPath: path });
        definition = fallback.getModel(provider, config.name);
      } finally {
        if (directory === undefined) await rm(modelDirectory, { recursive: true, force: true });
      }
    }
    if (!definition) throw new Error(`Harness could not configure model ${config.name}`);
    runtime.registerProvider(provider, { baseUrl: config.endpoint, api: config.api as Api,
      models: [{ ...definition, api: config.api as Api, baseUrl: config.endpoint }] });
  }
  if (provider === null) throw new TypeError("A provider is required without an endpoint");
  await runtime.setRuntimeApiKey(provider, auth.value);
  const model = runtime.getModel(provider, config.name);
  if (!model) throw new Error(`Harness model ${provider}/${config.name} is unavailable`);
  return { runtime, model, knownContext };
}

/** OpenAI-compatible APIs accept omitted output budgets; the service chooses. */
export function serviceOutputBudget(payload: unknown, api: string): unknown {
  if (!api.startsWith("openai-") || payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const copy = { ...payload };
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) Reflect.deleteProperty(copy, key);
  return copy;
}
