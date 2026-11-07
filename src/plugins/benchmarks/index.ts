import type { Context } from "@deepseek-ai/cordis";
import { apply as agentHarness } from "./agent-harness/index.js";
import { apply as inferenceEngine } from "./inference-engine/index.js";
import { apply as operator } from "./operator/index.js";
export async function apply(ctx: Context): Promise<void> {
  await agentHarness(ctx);
  await inferenceEngine(ctx);
  await operator(ctx);
}
