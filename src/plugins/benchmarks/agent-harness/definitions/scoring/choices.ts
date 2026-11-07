import type { VerifyResult } from "../../../../../core/contracts/result.js";
import { verdict } from "./evidence.js";

/** OpenAI simple-evals generative GPQA extraction. */
export function scoreChoice(expected: string, response: string): VerifyResult {
  const extracted = response.match(/Answer[ \t]*:[ \t]*\$?([A-D])\$?/i)?.[1] ?? null;
  return verdict(extracted === expected.toUpperCase(), extracted, "multichoice");
}

export function scoreMmluPro(expected: string, response: string): VerifyResult {
  const text = response.replaceAll("**", "");
  const extracted = text.match(/answer is \(?([A-J])\)?/)?.[1]
    ?? text.match(/.*[aA]nswer:\s*([A-J])/)?.[1]
    ?? text.match(/(?<![\p{L}\p{N}_])[A-J](?![\p{L}\p{N}_])(?!.*(?<![\p{L}\p{N}_])[A-J](?![\p{L}\p{N}_]))/su)?.[0] ?? null;
  return verdict(extracted === expected, extracted, "mmlu-pro-api");
}
