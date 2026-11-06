import { expect, test } from "vitest";
import { COMPACTION_RESERVE_TOKENS, contextWindowFor, modelFor } from "../../src/runtimes/pi/runner.js";
import type { RunnerInput } from "../../src/runtimes/pi/protocol.js";
import type { RuntimeAuth } from "../../src/core/contracts/config.js";

type RegisteredModel = { id: string; contextWindow: number; maxTokens: number };

function stubRuntime() {
  const providers = new Map<string, { models: RegisteredModel[] }>();
  return {
    providers,
    registerProvider(id: string, definition: { models: RegisteredModel[] }) {
      providers.set(id, definition);
    },
    async setRuntimeApiKey() {},
    getModel(id: string, name: string) {
      return providers.get(id)?.models.find(model => model.id === name);
    },
  };
}

const auth: RuntimeAuth = { value: "fixture-key", reference: null };
function input(overrides: Partial<RunnerInput["model"]>): RunnerInput {
  return {
    schemaVersion: 1,
    key: { runId: "r", taskId: "t", attemptId: "a" },
    input: { id: "t", prompt: "p" },
    model: { name: "fixture-model", endpoint: "https://model.invalid/v1", provider: null, api: "openai-completions", ...overrides },
    auth,
    workdir: "/app",
    outputDir: "/logs/agent",
  } as RunnerInput;
}

test("maxTokens is the compaction threshold: the registered window adds the summarizer reserve", () => {
  expect(contextWindowFor(384_000)).toBe(384_000 + COMPACTION_RESERVE_TOKENS);
  expect(contextWindowFor(undefined)).toBe(128_000 + COMPACTION_RESERVE_TOKENS);
  // shouldCompact(context, window, settings) triggers at window - reserve,
  // so a context above maxTokens is exactly the compaction point.
  expect(contextWindowFor(384_000) - COMPACTION_RESERVE_TOKENS).toBe(384_000);
});

test("an explicit endpoint registers the model with the configured budget", async () => {
  const runtime = stubRuntime();
  const model = await modelFor(input({ maxTokens: 384_000 }), runtime as never);
  expect(model).toMatchObject({ contextWindow: 384_000 + COMPACTION_RESERVE_TOKENS, maxTokens: 384_000 });
  expect(runtime.providers.get("ember-runtime")!.models[0]).toMatchObject({ contextWindow: 384_000 + COMPACTION_RESERVE_TOKENS });
});

test("without model metadata or maxTokens the output limit follows the published 128000 default", async () => {
  const runtime = stubRuntime();
  const model = await modelFor(input({}), runtime as never);
  expect(model).toMatchObject({ contextWindow: 128_000 + COMPACTION_RESERVE_TOKENS, maxTokens: 128_000 });
});

test("contextWindow changes compaction without adding a response output limit", async () => {
  const runtime = stubRuntime();
  const configured = input({ contextWindow: 200_000 });
  const model = await modelFor(configured, runtime as never);
  expect(model.contextWindow).toBe(200_000 + COMPACTION_RESERVE_TOKENS);
  expect(configured.model.maxTokens).toBeUndefined();
  expect(model.maxTokens).toBe(128_000);
});

test.each([null, "https://model.invalid/v1"])("a registered model keeps its own limit with endpoint %j", async endpoint => {
  const runtime = stubRuntime();
  runtime.registerProvider("openai", { models: [{ id: "fixture-model", contextWindow: 200000, maxTokens: 64000 }] });
  const model = await modelFor(input({ provider: "openai", endpoint }), runtime as never);
  expect(model.maxTokens).toBe(64000);
});
