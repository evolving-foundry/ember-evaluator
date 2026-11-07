import { assertJsonValue, expectNonEmptyString, expectRecord, rejectUnknown } from "./config/schema.js";
import type { PluginActivation } from "./core/contracts/plugin-extension.js";
import { fingerprintConfig } from "./core/run-manifest.js";

export function parsePluginActivations(value: unknown): PluginActivation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("plugins must be an array");
  const ids = new Set<string>();
  return value.map(value => {
    const item = expectRecord(value, "plugin activation");
    rejectUnknown(item, ["id", "config"], "plugin activation");
    const id = expectNonEmptyString(item.id, "plugin id");
    if (ids.has(id)) throw new TypeError(`Duplicate plugin activation: ${id}`);
    ids.add(id);
    const config = expectRecord(item.config ?? {}, `plugin ${id} config`);
    assertJsonValue(config);
    return { id, config: structuredClone(config) };
  });
}

export function restorePluginActivations(saved: unknown, requested: unknown): PluginActivation[] {
  const previous = parsePluginActivations(saved);
  const overrides = parsePluginActivations(requested);
  if (!overrides.length) return previous;
  if (fingerprintConfig(previous) !== fingerprintConfig(overrides)) throw new TypeError("Resume plugin options differ from the original run");
  return previous;
}
