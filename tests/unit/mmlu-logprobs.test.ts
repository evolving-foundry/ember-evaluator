import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { scoreMmluLogprobs } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/logprobs.js";
import { mmluDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/mmlu.js";
import { DefinedBenchmark } from "../../src/plugins/benchmarks/agent-harness/definitions/defined-benchmark.js";
import { object, required } from "../../src/plugins/benchmarks/agent-harness/definitions/records.js";
import type { DatasetRecordSource } from "../../src/infrastructure/datasets/record-source.js";
import type { ChatLogprobsEvidence, TokenLogprob } from "../../src/infrastructure/models/chat-logprobs.js";
import { parseChoiceLogprobsConfig } from "../../src/plugins/solvers/choice-logprobs.js";

const digest = createHash("sha256").update("prompt").digest("hex");
function evidence(topLogprobs: TokenLogprob[], token = topLogprobs[0] ?? { token: "The", logprob: -1 }, promptSha256 = digest): ChatLogprobsEvidence {
  return { schemaVersion: 1, protocol: "chat-logprobs-v1", model: "fixture", promptSha256, finishReason: "length", token, topLogprobs,
    parameters: { maxTokens: 1, temperature: 0, topLogprobs: 20, thinking: "disabled" } };
}

test("MMLU selects the highest option logprob and normalizes over four options", () => {
  const verdict = scoreMmluLogprobs("C", digest, evidence([
    { token: " A", logprob: -4 }, { token: "B", logprob: -3 }, { token: " C", logprob: -1 }, { token: "D", logprob: -2 },
  ], { token: "B", logprob: -3 }));
  expect(verdict).toMatchObject({ score: 1, passed: true, details: { selected: "C", officialComparable: false, missingChoices: [],
    choiceLogprobs: { A: -4, B: -3, C: -1, D: -2 } } });
  const details = object(verdict.details, "score");
  const probabilities = object(details.choiceProbabilities!, "probabilities");
  expect(Object.values(probabilities).reduce<number>((sum, value) => sum + Number(value), 0)).toBeCloseTo(1, 14);
});

test("MMLU uses the maximum whitespace variant and upstream missing-option -100 fallback", () => {
  expect(scoreMmluLogprobs("B", digest, evidence([
    { token: " B", logprob: -5 }, { token: "B", logprob: -1 }, { token: "C", logprob: -2 },
  ]))).toMatchObject({ passed: true, details: { choiceLogprobs: { A: -100, B: -1, C: -2, D: -100 }, missingChoices: ["A", "D"] } });
});

test("MMLU preserves first-letter tie breaking including all missing choices", () => {
  expect(scoreMmluLogprobs("A", digest, evidence([{ token: "A", logprob: -1 }, { token: "B", logprob: -1 }]))).toMatchObject({ passed: true });
  expect(scoreMmluLogprobs("A", digest, evidence([{ token: "The", logprob: -1 }]))).toMatchObject({ passed: true,
    details: { selected: "A", missingChoices: ["A", "B", "C", "D"], choiceProbabilities: { A: 0.25, B: 0.25, C: 0.25, D: 0.25 } } });
});

test("MMLU rejects absent, stale and malformed probability evidence", () => {
  expect(() => scoreMmluLogprobs("B", digest, undefined)).toThrow(/logprobs/);
  expect(() => scoreMmluLogprobs("B", digest, evidence([{ token: "B", logprob: -1 }], undefined, "different"))).toThrow(/matching/);
  expect(() => scoreMmluLogprobs("B", digest, evidence([]))).toThrow(/top_logprobs/);
  expect(() => scoreMmluLogprobs("B", digest, evidence([{ token: "B", logprob: 0.1 }]))).toThrow(/logprob/);
});

test("MMLU uses five same-subject examples without disclosing the test answer", async () => {
  const examples = Array.from({ length: 6 }, (_, i) => ({ subject: "abstract_algebra", question: `dev ${i}`, choices: ["a", "b", "c", "d"], answer: i % 4 }));
  const source: DatasetRecordSource = {
    async resolve(previous) { return previous ?? { source: "fixture", revision: "1", files: [], metadata: null }; },
    async *rows(_lock, selection) {
      if (selection === "dev") { yield* examples; yield { subject: "other", question: "wrong subject", choices: ["a", "b", "c", "d"], answer: 0 }; }
      else yield { subject: "abstract_algebra", question: "test question", choices: ["a", "b", "c", "d"], answer: 1 };
    },
  };
  const benchmark = new DefinedBenchmark(mmluDefinition, source, { dockerExecutable: "docker" });
  const signal = new AbortController().signal;
  const lock = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(lock, signal)) refs.push(ref);
  expect(refs).toHaveLength(1);
  const task = await benchmark.prepare(refs[0]!, lock, signal);
  expect(task.input.prompt).toMatch(/^The following are multiple choice questions \(with answers\) about  abstract algebra\.\n\n/);
  expect(task.input.prompt).toContain("dev 0\nA. a\nB. b\nC. c\nD. d\nAnswer: A\n\n");
  expect(task.input.prompt).not.toContain("dev 5");
  expect(task.input.prompt).not.toContain("wrong subject");
  expect(task.input.prompt).not.toContain("Think step by step");
  expect(task.input.prompt).toMatch(/test question\nA\. a\nB\. b\nC\. c\nD\. d\nAnswer:$/);
  // The answer-only instruction applies to the scored question only, not the dev examples.
  expect(task.input.prompt.match(/Answer with exactly one letter: A, B, C, or D\./g)).toHaveLength(1);
  expect(task.input.prompt).toMatch(/Answer with exactly one letter: A, B, C, or D\.\nDo not provide an explanation\.\n\nQuestion: test question\nA\. a\nB\. b\nC\. c\nD\. d\nAnswer:$/);
  expect(task.input.prompt).not.toMatch(/Answer: [ABCD] Answer with exactly one letter/);
  const verification = object(task.verification, "private data");
  const observations = evidence([{ token: "B", logprob: -0.1 }], undefined, required(verification.promptSha256, "digest"));
  expect(await benchmark.verify(task, { finalText: "Answer: A", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, observations }, null, signal))
    .toMatchObject({ score: 1, passed: true, details: { shots: 5, subject: "abstract_algebra", selected: "B" } });
  await expect(benchmark.verify(task, { finalText: "Answer: B", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, null, signal)).rejects.toThrow(/logprobs/);
});

test("MMLU rejects missing dev examples instead of changing the shot count", () => {
  expect(() => mmluDefinition.prepare("test", { selection: "test", value: { subject: "math", question: "test", choices: ["a", "b", "c", "d"], answer: 1 } }, 0, {}))
    .toThrow(/five dev examples/);
});

test.each([{ topLogprobs: 0 }, { topLogprobs: 21 }, { topLogprobs: 1.5 }, { thinking: true }, { unknown: true }])("choice-logprobs rejects invalid config %j", value => {
  expect(() => parseChoiceLogprobsConfig(value)).toThrow();
});
