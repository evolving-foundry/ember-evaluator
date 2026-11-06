import type { Context } from "@deepseek-ai/cordis";
import { expectRecord, rejectUnknown } from "../core/validation/input.js";
import { SuccessRateMetrics } from "./metrics/success-rate.js";
import { DurationMetrics } from "./metrics/duration.js";
import { UsageMetrics } from "./metrics/usage.js";
import { HarborScoreMetrics, parseHarborScoreConfig } from "./metrics/harbor-score.js";
import { MarkdownReporter } from "./reporters/markdown.js";
import { AgentXPerformanceMetrics } from "./metrics/agentx-performance.js";
import { QualityScoreMetrics } from "./metrics/quality-score.js";
import { KernelMetrics } from "./metrics/kernel.js";

export const inject = ["evaluator"];
export function apply(ctx: Context): void {
  ctx.evaluator.register("metrics", "harbor-score", parseHarborScoreConfig, config => new HarborScoreMetrics(config));
  const empty = (value: unknown) => {
    const config = expectRecord(value, "plugin config");
    rejectUnknown(config, [], "plugin config");
    return {};
  };
  ctx.evaluator.register("metrics", "success-rate", empty, () => new SuccessRateMetrics());
  ctx.evaluator.register("metrics", "duration", empty, () => new DurationMetrics());
  ctx.evaluator.register("metrics", "usage", empty, () => new UsageMetrics());
  ctx.evaluator.register("metrics", "agentx-performance", empty, () => new AgentXPerformanceMetrics());
  ctx.evaluator.register("metrics", "quality-score", empty, () => new QualityScoreMetrics());
  ctx.evaluator.register("metrics", "kernel", empty, () => new KernelMetrics());
  ctx.evaluator.register("reporter", "markdown", empty, () => new MarkdownReporter());
}
