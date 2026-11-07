import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { AttemptRecord, Usage } from "../contracts/result.js";
import { trajectoryType } from "./record-validation.js";

/** Sum only persisted provider usage, never infer server consumption from request duration. */
export async function collectAttemptAccounting(root: string, record: Pick<AttemptRecord, "key" | "solve" | "accounting">): Promise<void> {
  const usage: Usage = { inputTokens: null, outputTokens: null, totalTokens: null };
  let cost: number | null = null;
  {
    const stream = createReadStream(join(root, "agent/trajectory.jsonl"), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let ordinal = 0;
    try {
      for await (const line of lines) {
        const event: unknown = JSON.parse(line);
        const type = trajectoryType(event, record.key, ++ordinal);
        if (!event || typeof event !== "object" || !("data" in event)) continue;
        const data = event.data;
        if (type === "usage" && data && typeof data === "object") {
          // These are cumulative checkpoints, not additional model calls.
          // Keep a longer observed prefix if a checkpoint is stale or partial.
          for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
            const value = Object.getOwnPropertyDescriptor(data, key)?.value;
            if (Number.isSafeInteger(value) && value >= 0) usage[key] = Math.max(usage[key] ?? 0, value);
          }
          const price = Object.getOwnPropertyDescriptor(data, "cost")?.value;
          if (typeof price === "number" && Number.isFinite(price) && price >= 0) cost = Math.max(cost ?? 0, price);
          continue;
        }
        if (type !== "message") continue;
        if (!data || typeof data !== "object" || !("role" in data) || data.role !== "assistant" || !("usage" in data)) continue;
        const raw = data.usage;
        if (!raw || typeof raw !== "object") continue;
        const count = (key: string) => { const value = Object.getOwnPropertyDescriptor(raw, key)?.value; return Number.isSafeInteger(value) && value >= 0 ? value as number : null; };
        const input = [count("input"), count("cacheRead"), count("cacheWrite")];
        const values = { inputTokens: input.some(value => value !== null) ? input.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null,
          outputTokens: count("output"), totalTokens: count("totalTokens") };
        // An error-only provider response commonly carries synthetic zero usage; it is unknown.
        if (!Object.values(values).some(value => value !== null && value > 0)) continue;
        for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const)
          if (values[key] !== null) usage[key] = (usage[key] ?? 0) + values[key];
        const price = Object.getOwnPropertyDescriptor(raw, "cost")?.value;
        if (price && typeof price.total === "number" && Number.isFinite(price.total) && price.total >= 0) cost = (cost ?? 0) + price.total;
      }
    } catch { /* A missing or truncated trajectory preserves only the known valid prefix. */ }
    finally { lines.close(); stream.destroy(); }
  }
  // Solvers without detailed trajectories may only report their final totals.
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = record.solve?.usage[key];
    if (value !== null && value !== undefined) usage[key] = Math.max(usage[key] ?? 0, value);
  }
  const observations = record.solve?.observations;
  const incomplete = observations && typeof observations === "object" && !Array.isArray(observations) && observations.incomplete === true;
  record.accounting = { usage, cost, currency: cost === null ? null : "USD", complete: record.solve !== null && !incomplete };
}
