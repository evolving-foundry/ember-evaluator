import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { createHarnessModel, serviceOutputBudget } from "../../src/runtimes/pi/model.js";

test("custom endpoints preserve recognized Harness model metadata", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const original = runtime.getModel("openai", "gpt-4.1");
  expect(original).toBeDefined();
  const configured = await createHarnessModel({ name: "gpt-4.1", provider: "openai", endpoint: "https://model.invalid/v1", api: "openai-completions" }, { value: "fixture", reference: null });
  expect(configured.knownContext).toBe(true);
  expect(configured.model.contextWindow).toBe(original?.contextWindow);
  expect(configured.model.maxTokens).toBe(original?.maxTokens);
});

test("unknown models do not write Evaluator model budgets or assume a known window", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-test-"));
  try {
    const configured = await createHarnessModel({ name: "private-unknown-model", provider: null, endpoint: "https://model.invalid/v1", api: "openai-completions" }, { value: "secret", reference: null }, root);
    expect(configured.knownContext).toBe(false);
    const text = await readFile(join(root, "model-config.json"), "utf8");
    expect(text).not.toMatch(/maxTokens|contextWindow|secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional API output budgets are omitted without changing source payloads", () => {
  const payload = { messages: [], max_tokens: 100, max_completion_tokens: 100, max_output_tokens: 100 };
  expect(serviceOutputBudget(payload, "openai-completions")).toEqual({ messages: [] });
  expect(payload.max_tokens).toBe(100);
  // Required protocol fields remain the Harness's responsibility.
  expect(serviceOutputBudget(payload, "anthropic-messages")).toBe(payload);
});
