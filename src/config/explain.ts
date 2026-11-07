import type { LoadedConfig } from "./loaded.js";
import { exportConfig } from "./export.js";

const SERVICE_FIELDS: Record<string, string> = { model: "name", base_url: "endpoint", api_key: "apiKey" };

export function explainConfig(config: LoadedConfig): string {
  const lines: string[] = [];
  const origins = config.resolution?.origins ?? {};
  const origin = (path: string): string => {
    let current = path.replace(/^services\.([^.]+)\.(model|base_url|api_key)$/, (_, name: string, field: string) =>
      `services.${name}.${SERVICE_FIELDS[field]}`)
      .replace(/^benchmark\.(solver|verifier)\./, "$1.");
    for (;;) {
      const found = origins[current];
      if (found) return found;
      const index = current.lastIndexOf(".");
      if (index < 0) return origins[""] ?? "framework default";
      current = current.slice(0, index);
    }
  };
  const walk = (value: unknown, path: string) => {
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key);
    } else lines.push(`${path}: ${JSON.stringify(value)}  [${origin(path)}]`);
  };
  walk(exportConfig(config), "");
  return lines.join("\n");
}
