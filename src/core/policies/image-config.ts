import type { ConfigTransportLookup } from "../contracts/config-transport.js";
import type { JsonValue } from "../contracts/task.js";
import { fingerprintConfig } from "../results/run-manifest.js";

/** Image ownership ignores credentials, output paths and scheduling, retaining task selection. */
export function fingerprintImageConfig(config: JsonValue, lookup?: ConfigTransportLookup): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("Invalid image configuration");
  const selected: Record<string, JsonValue> = {};
  if (config.hardware !== undefined && config.hardware !== "npu") selected.hardware = config.hardware;
  for (const role of ["benchmark", "environment", "solver", "verifier"]) {
    const selection = config[role];
    if (!selection || typeof selection !== "object" || Array.isArray(selection) || typeof selection.name !== "string") continue;
    const value = structuredClone(selection);
    if (value.config && typeof value.config === "object" && !Array.isArray(value.config)) {
      const transport = lookup?.(role, selection.name);
      for (const field of [...Object.keys(transport?.nodeLocal ?? {}), ...(transport?.secretFields ?? [])]) delete value.config[field];
    }
    selected[role] = value;
  }
  const run = config.run;
  if (run && typeof run === "object" && !Array.isArray(run)) {
    const selection: Record<string, JsonValue> = {};
    for (const key of ["taskIds", "maxTasks", "sampling", "offset"]) if (run[key] !== undefined) selection[key] = run[key]!;
    selected.selection = selection;
  }
  return fingerprintConfig(selected);
}
