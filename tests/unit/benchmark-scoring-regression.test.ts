import { expect, test } from "vitest";
import { scoreChoice, scoreMmluPro } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/choices.js";
import { scoreGsm8k, scoreTrivia } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/answers.js";
import { scoreDrop, scoreDropCandidates } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/drop.js";
import { mgsmDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/mgsm.js";
import { mmluProDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/mmlu-pro.js";
import { MGSM_ANSWER_PREFIXES } from "../../src/plugins/benchmarks/agent-harness/definitions/prompts.js";
import { PythonRandom } from "../../src/plugins/benchmarks/agent-harness/definitions/python-random.js";
import { gpqaDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/gpqa.js";
import { triviaqaDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/triviaqa.js";

test.each([
  ["42", "#### 42", true], ["42", "The answer is 42", false],
  ["1000", "work: 999\n#### 1,000", true], ["42", "#### 41\n#### 42", false],
  ["42", "#### 42.0", false], ["-42", "#### -42", true], ["42", "", false],
])("GSM8K uses the original extraction rule: %s / %s", (expected, response, passed) => {
  expect(scoreGsm8k(expected, response).passed).toBe(passed);
});

test("GPQA and MMLU-Pro retain their own upstream extraction rules", () => {
  expect(scoreChoice("B", "Answer: $B$").passed).toBe(true);
  expect(scoreChoice("B", "The answer is (B)").passed).toBe(false);
  expect(scoreMmluPro("C", "The answer is (C)").passed).toBe(true);
  expect(scoreMmluPro("C", "Answer: A; final Answer: C").passed).toBe(true);
  expect(scoreMmluPro("C", "Answer: A\nAnswer: C").passed).toBe(false);
  expect(scoreMmluPro("C", "I choose C").passed).toBe(true);
  expect(scoreMmluPro("C", "**The answer is (C)**").passed).toBe(true);
});

test("GPQA seed 0 uses the same successive four-option permutations as Python", () => {
  const expected = [[3, 1, 0, 2], [3, 1, 2, 0], [2, 3, 0, 1], [2, 0, 3, 1], [1, 3, 0, 2], [2, 1, 0, 3]];
  const rows = expected.map(() => ({ selection: "test", value: {
    Question: "question", "Correct Answer": "0", "Incorrect Answer 1": "1", "Incorrect Answer 2": "2", "Incorrect Answer 3": "3",
  } }));
  const transformed = gpqaDefinition.transformRows!(rows);
  transformed.forEach((row, index) => {
    expect(row.value).toMatchObject({ __options: expected[index]!.map(String), __answer: "ABCD"[expected[index]!.indexOf(0)] });
  });
  expect(new PythonRandom(42).sampleIndices(100, 3)).toEqual([81, 14, 3]);
});

test.each([
  ["New York", "New-York", true, 1], ["O'Connor", "OConnor", false, 0],
  ["New York", "New", false, 2 / 3], ["a cat", "cat", true, 1],
  ["New_York", "New York", true, 1], ["O’Connor", "O Connor", true, 1],
  ["café", "cafe", false, 0], ["cat", "cat\nincorrect extra answer", false, 0.4],
])("TriviaQA matches official EM/F1: %s / %s", (alias, response, passed, f1) => {
  const result = scoreTrivia([alias], response);
  expect(result.passed).toBe(passed);
  expect(result.details).toMatchObject({ exactMatch: passed, f1 });
});

test("TriviaQA counts repeated tokens and maximizes each metric over aliases", () => {
  expect(scoreTrivia(["red red blue", "green"], "red blue blue").details).toMatchObject({ f1: 2 / 3, exactMatch: false });
  expect(scoreTrivia(["red red blue", "red blue blue"], "red blue blue")).toMatchObject({ score: 1, passed: true, details: { f1: 1 } });
});

test("TriviaQA preserves the released NormalizedAliases reference set", async () => {
  const task = triviaqaDefinition.prepare("task", { selection: "test", value: {
    question: "Which article?", answer: { value: "a", aliases: ["an unrelated alias"], normalized_aliases: [""] },
  } }, 0, null);
  expect(task.verification).toMatchObject({ aliases: [""] });
  expect(await triviaqaDefinition.verify(task.verification, "the", { dockerExecutable: "docker" }, new AbortController().signal))
    .toMatchObject({ score: 1, passed: true, details: { f1: 0 } });
});

test("DROP rounds exact binary floats to two decimals like CPython", () => {
  expect(scoreDrop(["shared a1 a2 a3 a4 a5 a6 a7"], "shared b1 b2 b3 b4 b5 b6 b7").score).toBe(0.12);
  expect(scoreDrop(["x1 x2 x3 x4"], "x1 z1 z2 z3 z4 z5 z6 z7 z8 z9 z10 z11").score).toBe(0.12);
});

test("DROP maximizes over complete alternative annotations", () => {
  expect(scoreDropCandidates([["Alice", "Bob"], ["Alice Smith", "Bob Jones"]], 'Answer: ["Alice"]'))
    .toMatchObject({ score: 0.5, passed: false });
  expect(scoreDrop(["Alice", "Bob"], 'Answer: ["Alice", "Bob", "the"]')).toMatchObject({ score: 0.67, passed: false });
  expect(scoreDrop(["Alice", "the"], 'Answer: []')).toMatchObject({ score: 0, passed: false });
});

test.each(mgsmDefinition.selections)("MGSM uses the localized prompt and prefix for %s", async language => {
  const prepared = mgsmDefinition.prepare("task", { selection: language, value: { question: "q", answer_number: "42" } }, 0, null);
  const prefix = MGSM_ANSWER_PREFIXES[language];
  expect(prefix).toBeDefined();
  expect(prepared.input.prompt).toContain(prefix);
  const context = { dockerExecutable: "docker" }, signal = new AbortController().signal;
  expect(await mgsmDefinition.verify(prepared.verification, `${prefix}: 42`, context, signal)).toMatchObject({ score: 1 });
  expect(await mgsmDefinition.verify(prepared.verification, "work has 42", context, signal)).toMatchObject({ score: 0 });
});

test("MMLU-Pro includes only same-category CoT examples and removes N/A options", () => {
  const task = mmluProDefinition.prepare("task", { selection: "test", value: {
    question: "test question", category: "math", options: ["first", "second", "N/A"], answer: "B",
  } }, 0, [
    { question: "math example", category: "math", options: ["one", "two", "N/A"], cot_content: "A: work. The answer is (B)." },
    { question: "biology example", category: "biology", options: ["yes", "no"], cot_content: "reason" },
  ]);
  expect(task.input.prompt).toContain("math example");
  expect(task.input.prompt).toContain("Answer: work. The answer is (B).");
  expect(task.input.prompt).toContain("Answer: Let's think step by step.");
  expect(task.input.prompt).not.toContain("biology example");
  expect(task.input.prompt).not.toContain("N/A");
});
