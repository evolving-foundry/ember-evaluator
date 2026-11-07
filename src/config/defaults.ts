import type { Selection } from "../core/contracts/config.js";

export const DEFAULT_LOCAL_CONCURRENCY = 1;

export const DEFAULT_METRICS: readonly Selection[] = [
  { name: "success-rate", config: {} },
  { name: "duration", config: {} },
  { name: "usage", config: {} },
];

export const KNOWN_PROVIDERS = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai",
  "deepseek",
  "google",
  "groq",
  "mistral",
  "openai",
  "xai",
]);

export const KNOWN_APIS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);
