import type { VerifyResult } from "../../../../../core/contracts/result.js";
import { createHash } from "node:crypto";
import type { BenchmarkDefinitionContext } from "../benchmark-definition.js";
import { expectRecord } from "../../../../../core/validation/input.js";

export const JUDGE_REFERENCE = "https://github.com/openai/simple-evals/tree/652c89d0ca9df547706735883097e9537d40dc47";

export function requireJudge(context: BenchmarkDefinitionContext) {
  if (!context.judge) throw new TypeError("An explicit judgeService with credentials is required");
  return context.judge;
}

export function judgeEvidence(protocol: string, prompts: string[], context: BenchmarkDefinitionContext) {
  const { model } = requireJudge(context);
  return { protocol, version: 1, officialComparable: false, reference: JUDGE_REFERENCE,
    judgeModel: model.name, judgeProvider: model.provider, judgeApi: model.api,
    judgeService: context.judgeService ?? null,
    parameters: { maxTokens: model.maxTokens ?? null,
      outputLimit: model.endpoint !== null && model.api === "openai-completions" && model.maxTokens === undefined ? "provider-default" : "configured-or-sdk-default" },
    promptHashes: prompts.map(prompt => createHash("sha256").update(prompt).digest("hex")) };
}

export function parseJudgeObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  return expectRecord(value, "Judge JSON");
}

export function verdict(correct: boolean, extracted: string | null, method: string): VerifyResult {
  return { score: correct ? 1 : 0, passed: correct, details: { extracted, method } };
}
