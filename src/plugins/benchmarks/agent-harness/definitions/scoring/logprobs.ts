import type { JsonValue } from "../../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../../core/contracts/result.js";
import { object, required } from "../records.js";
import { tokenLogprob } from "../../../../../infrastructure/models/chat-logprobs.js";

export function scoreMmluLogprobs(expected: string, promptSha256: string, observations: JsonValue | undefined): VerifyResult {
  const evidence = object(observations ?? null, "MMLU requires choice-logprobs solver evidence");
  if (evidence.schemaVersion !== 1 || evidence.protocol !== "chat-logprobs-v1" || evidence.promptSha256 !== promptSha256)
    throw new TypeError("MMLU requires matching versioned token logprobs; generated answer text cannot be used for scoring");
  if (!Array.isArray(evidence.topLogprobs) || !evidence.topLogprobs.length) throw new TypeError("MMLU requires nonempty top_logprobs");
  const candidates = [...evidence.topLogprobs.map(tokenLogprob), tokenLogprob(evidence.token)];
  const letters = ["A", "B", "C", "D"];
  const missingChoices: string[] = [];
  const logprobs = letters.map(letter => {
    const found = candidates.filter(item => item.token.trim() === letter).map(item => item.logprob);
    if (!found.length) missingChoices.push(letter);
    return found.length ? Math.max(...found) : -100;
  });
  const maximum = Math.max(...logprobs);
  const selected = letters[logprobs.indexOf(maximum)] ?? "A";
  const weights = logprobs.map(value => Math.exp(value - maximum));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const passed = selected === expected;
  return { score: passed ? 1 : 0, passed, details: { protocol: "mmlu-chat-logprobs-v1", version: 1, officialComparable: false,
    reference: "https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py",
    selected, choiceLogprobs: Object.fromEntries(letters.map((letter, index) => [letter, logprobs[index] ?? -100])),
    choiceProbabilities: Object.fromEntries(letters.map((letter, index) => [letter, (weights[index] ?? 0) / total])),
    missingChoices, missingChoiceFallback: -100, tokenPolicy: "highest-logprob-whitespace-variant",
    promptSha256, responseModel: required(evidence.model, "MMLU response model"), evidence } };
}
