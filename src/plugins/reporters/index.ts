import type { Context } from "@deepseek-ai/cordis";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { MarkdownReporter } from "./markdown.js";

export const inject = ["evaluator"];
export function apply(ctx: Context): void {
  ctx.evaluator.register("reporter", "markdown", value => {
    const config = expectRecord(value, "plugin config");
    rejectUnknown(config, [], "plugin config");
    return {};
  }, () => new MarkdownReporter());
}
