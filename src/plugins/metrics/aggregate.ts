import type { Metrics, MetricResults } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { assertJsonValue } from "../../core/validation/input.js";

export async function aggregateMetrics(snapshot: ResultSnapshot, plugins: Metrics[]): Promise<MetricResults> {
  if (!snapshot.run.source) return { initialization: { taskSet: "undetermined", selected: null, valid: null, coverage: null,
    error: snapshot.run.failure?.code ?? null } };
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.name.trim() || names.has(plugin.name))
      throw new Error(`Invalid or duplicate metric name: ${plugin.name}`);
    names.add(plugin.name);
  }
  const metrics: MetricResults = Object.create(null) as MetricResults;
  for (const plugin of plugins) {
    const value = await plugin.compute(structuredClone(snapshot));
    assertJsonValue(value, `metrics.${plugin.name}`);
    metrics[plugin.name] = value;
  }
  if (snapshot.attemptHistory) {
    const attempts = snapshot.attemptHistory;
    const records = attempts.flatMap(attempt => attempt.record ? [attempt.record] : []);
    const partialAttempts = records.filter(record => record.accounting?.complete === false).length;
    const usage: Record<string, JsonValue> = {};
    for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const known = records.map(record => (record.accounting?.usage ?? record.solve?.usage)?.[field]).filter((value): value is number => typeof value === "number");
      usage[field] = {
        total: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
        covered: known.length,
        attempts: attempts.length,
        partialAttempts,
      };
    }
    const preparationDurationMs = snapshot.run.preparationRounds?.reduce((sum, round) =>
      sum + (round.finishedAt === null ? 0 : Date.parse(round.finishedAt) - Date.parse(round.startedAt)), 0) ?? null;
    const knownTotal = records.some(record => record.accounting?.cost !== null && record.accounting?.cost !== undefined)
      ? records.reduce((sum, record) => sum + (record.accounting?.cost ?? 0), 0) : null;
    const unknownAttempts = attempts.length - records.filter(record => record.accounting?.complete && record.accounting.cost != null).length;
    metrics["attempt-accounting"] = {
      attempts: attempts.length,
      preparationDurationMs,
      durationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
      usage,
      cost: { knownTotal, unknownAttempts, currency: "USD" },
    };
  }
  return metrics;
}
