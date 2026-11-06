import type { VerifyResult } from "../../../../../core/contracts/result.js";
import { verdict } from "./evidence.js";

function normalizeText(value: string): string {
  return value.replaceAll("_", " ").toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~‘’´]/g, " ")
    .replace(/(?<![\p{L}\p{N}_])(a|an|the)(?![\p{L}\p{N}_])/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function scoreGsm8k(expected: string, response: string): VerifyResult {
  const extracted = response.match(/#### (-?[0-9.,]+)/)?.[1]?.trim().replaceAll(",", "") ?? null;
  return verdict(extracted === expected, extracted, "gsm8k-original");
}

export function scoreNumeric(expected: string, response: string, prefix: string): VerifyResult {
  const answer = response.includes(prefix) ? response.split(prefix).at(-1) ?? "" : "";
  const numbers = answer.replaceAll(",", "").match(/\d+\.?\d*/g);
  const extracted = numbers?.at(-1)?.replace(/\.$/, "") ?? "";
  const normalized = extracted.includes(".") ? extracted.replace(/0+$/, "").replace(/\.$/, "") : extracted;
  return verdict(normalized === expected.replaceAll(",", ""), extracted, "mgsm-simple-evals");
}

export function scoreTrivia(aliases: string[], response: string): VerifyResult {
  const extracted = response;
  const prediction = normalizeText(extracted);
  const exactMatch = aliases.some(value => normalizeText(value) === prediction);
  const predicted = prediction.split(/\s+/).filter(Boolean);
  const f1 = Math.max(0, ...aliases.map(value => {
    const gold = normalizeText(value).split(/\s+/).filter(Boolean);
    const counts = new Map<string, number>();
    for (const token of gold) counts.set(token, (counts.get(token) ?? 0) + 1);
    let common = 0;
    for (const token of predicted) {
      const count = counts.get(token) ?? 0;
      if (count > 0) { common++; counts.set(token, count - 1); }
    }
    if (!common) return 0;
    const precision = common / predicted.length, recall = common / gold.length;
    return 2 * precision * recall / (precision + recall);
  }));
  return { score: exactMatch ? 1 : 0, passed: exactMatch, details: { extracted, method: "trivia", exactMatch, f1 } };
}
