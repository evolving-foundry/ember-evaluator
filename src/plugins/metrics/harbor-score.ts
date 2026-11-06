import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { scoringRecords } from "./records.js";

export function parseHarborScoreConfig(value: unknown): { dimensions: string[] } {
  const config = expectRecord(value, "harbor-score");
  rejectUnknown(config, ["dimensions"], "harbor-score");
  const dimensions = config.dimensions ?? [];
  if (!Array.isArray(dimensions) || dimensions.some(value => typeof value !== "string" || !value)) throw new TypeError("Invalid reward dimensions");
  return { dimensions: dimensions as string[] };
}
export class HarborScoreMetrics implements Metrics {
  readonly name = "harbor-score";
  constructor(private readonly config: { dimensions: string[] }) {}
  async compute(snapshot: ResultSnapshot) {
    const { records, selected, denominator, invalid } = scoringRecords(snapshot);
    if (snapshot.run.evaluationKind === "performance")
      return { applicable: false, selected, denominator: null, invalid: 0, verified: 0, passed: null,
        meanReward: null, dimensions: Object.fromEntries(this.config.dimensions.map(key => [key, null])) };
    const verified = records.filter(record => record.verdict !== null);
    const scores = records.flatMap(record => record.verdict?.score === undefined ? [] : [record.verdict.score]);
    const complete = verified.every(record => record.verdict?.score !== undefined);
    const dimensions = Object.fromEntries(this.config.dimensions.map(key => {
      const values = verified.flatMap(record => {
        const details = record.verdict?.details;
        const rewards = details && typeof details === "object" && !Array.isArray(details) ? details.rewards : undefined;
        const value = rewards && typeof rewards === "object" && !Array.isArray(rewards) ? rewards[key] : undefined;
        return typeof value === "number" && Number.isFinite(value) ? [value] : [];
      });
      return [key, values.length && denominator && values.length === verified.length
        ? values.reduce((a, b) => a + b, 0) / denominator : null];
    }));
    return { selected, denominator, invalid, verified: verified.length, passed: verified.filter(record => record.verdict?.passed).length,
      meanReward: denominator && complete ? scores.reduce((a, b) => a + b, 0) / denominator : null, dimensions };
  }
}
