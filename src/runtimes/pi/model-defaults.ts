import { readFile } from "node:fs/promises";

export type ModelDefaults = { fallback: { maxTokens: number }; models: Record<string, { maxTokens: number }> };
let defaults: Promise<ModelDefaults> | undefined;

function limits(value: unknown): { maxTokens: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "maxTokens") || !("maxTokens" in value) ||
      typeof value.maxTokens !== "number" || !Number.isSafeInteger(value.maxTokens) || value.maxTokens <= 0)
    throw new TypeError("Model defaults require a positive integer maxTokens");
  return { maxTokens: value.maxTokens };
}

export function parseModelDefaults(value: unknown): ModelDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["fallback", "models"].includes(key)) ||
      !("fallback" in value) || !("models" in value) || !value.models ||
      typeof value.models !== "object" || Array.isArray(value.models))
    throw new TypeError("Invalid model defaults configuration");
  return { fallback: limits(value.fallback), models: Object.fromEntries(Object.entries(value.models).map(([id, value]) => {
    if (!id.trim()) throw new TypeError("Model default ID must not be empty");
    return [id, limits(value)];
  })) };
}

export function loadModelDefaults(): Promise<ModelDefaults> {
  return defaults ??= readFile(new URL("./model-defaults.json", import.meta.url), "utf8")
    .then(text => parseModelDefaults(JSON.parse(text)));
}

export function outputLimitFor(
  defaults: ModelDefaults, name: string, provider: string | null, explicit: number | undefined, registered: number | undefined,
): number {
  return explicit ?? (provider === null ? undefined : defaults.models[`${provider}/${name}`]?.maxTokens)
    ?? defaults.models[name]?.maxTokens ?? registered ?? defaults.fallback.maxTokens;
}
