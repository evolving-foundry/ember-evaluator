import { beforeEach, expect, test, vi } from "vitest";
import { completeJudge } from "../../src/infrastructure/models/judge.js";
import { simpleqaDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/simpleqa.js";
import { healthbenchDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/healthbench.js";
import { scoreDrop } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/drop.js";
import { dropDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/drop.js";
import { assertAttemptRecord, assertVerifyResult } from "../../src/core/results/record-validation.js";
import { finalizeAttemptOutcome } from "../../src/core/results/evaluation-outcome.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { QualityScoreMetrics } from "../../src/plugins/metrics/quality-score.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { VerificationError } from "../../src/index.js";

vi.mock("../../src/infrastructure/models/judge.js", () => ({ completeJudge: vi.fn() }));
beforeEach(() => vi.mocked(completeJudge).mockReset());
const context = { dockerExecutable: "docker", judgeService: "judge", judge: {
  model: { name: "judge-model", endpoint: "https://judge.invalid", provider: null, api: "openai-completions" },
  auth: { value: "private-judge-key", reference: "JUDGE_KEY" },
} };
const signal = () => new AbortController().signal;

test.each([
  [["42"], "", 0, false], [[""], "anything", 0, false],
  [["42"], "Answer: 142", 0, false], [["1000"], "Answer: 1,000", 1, true],
  [["New York"], "Answer: York", 0.67, false],
  [["Alice", "Bob"], 'Answer: ["Bob", "Alice"]', 1, true],
  [["Alice", "Bob"], 'Answer: ["Alice"]', 0.5, false],
  [["12 cats"], "Answer: 13 cats", 0, false],
])("DROP scores spans %j / %s", (answers, response, score, passed) => {
  expect(scoreDrop(answers, response)).toMatchObject({ score, passed });
});

test("DROP preserves multi-span annotations and alternative annotators", async () => {
  const training = { passage: "example", question: "how many?", answer: { number: "1" } };
  const task = dropDefinition.prepare("test:1", { selection: "test", value: {
    passage: "Alice and Bob have the highest score.", question: "Which people?",
    answer: { spans: ["Alice", "Bob"] }, validated_answers: [{ spans: ["Alice Smith", "Bob Jones"] }],
  } }, 1, [training, training, training]);
  expect(task.input.prompt).toContain('Question: how many?\nAnswer: 1');
  expect(task.verification).toMatchObject({ candidates: [["Alice", "Bob"], ["Alice Smith", "Bob Jones"]] });
  const grade = await dropDefinition.verify(task.verification, 'Answer: ["Bob", "Alice"]', context, signal());
  expect(grade).toMatchObject({ score: 1, passed: true, details: { candidateCount: 2, referenceGrouping: "official-annotations", officialComparable: false } });
  expect(await dropDefinition.verify(task.verification, "Answer: Alice", context, signal())).toMatchObject({ score: 0.5, passed: false });
  expect(await dropDefinition.verify(task.verification, 'Answer: ["Bob Jones", "Alice Smith"]', context, signal())).toMatchObject({ score: 1, passed: true });
});

test.each(["invalid JSON private-judge-key", '{"criteria_met":"true","explanation":"bad"}', null])("HealthBench preserves partial evidence on judge failure: %s", async output => {
  vi.mocked(completeJudge).mockResolvedValueOnce('{"criteria_met":true,"explanation":"first criterion"}');
  if (output === null) vi.mocked(completeJudge).mockRejectedValueOnce(new Error("Judge request timed out private-judge-key"));
  else vi.mocked(completeJudge).mockResolvedValueOnce(output);
  const pending = healthbenchDefinition.verify({ kind: "judge", conversation: [{ role: "user", content: "question" }],
    criteria: [{ criterion: "first", points: 2 }, { criterion: "second", points: -1 }] }, "response", context, signal());
  const error: unknown = await Promise.resolve(pending).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(VerificationError);
  if (!(error instanceof VerificationError)) throw new Error("Expected verification evidence");
  expect(error.evidence).toMatchObject({ protocol: "healthbench-simple-evals-v1", judgeService: "judge", possible: 2,
    grades: [{ criterion: "first", points: 2, criteriaMet: true, explanation: "first criterion" }],
    promptHashes: [expect.stringMatching(/^[a-f0-9]{64}$/), expect.stringMatching(/^[a-f0-9]{64}$/)],
    failedRubric: { index: 1, criterion: "second", rawOutput: output?.replaceAll("private-judge-key", "[redacted]") ?? null, error: expect.any(String) } });
  expect(error.evidence).not.toHaveProperty("score");
  expect(JSON.stringify(error.evidence)).not.toContain("private-judge-key");
  expect(error.cause).toBeInstanceOf(Error);
});

test.each(["CORRECT", "INCORRECT", "NOT_ATTEMPTED"])("SimpleQA preserves %s", async grade => {
  vi.mocked(completeJudge).mockResolvedValue(grade === "CORRECT" ? "A" : grade === "INCORRECT" ? "B" : "C");
  const verdict = await simpleqaDefinition.verify({ kind: "judge", instruction: "question", expected: "answer" }, "prediction", context, signal());
  expect(verdict).toMatchObject({ score: grade === "CORRECT" ? 1 : 0, passed: grade === "CORRECT", details: { grade, protocol: "simpleqa-simple-evals-v1", officialComparable: false } });
  expect(JSON.stringify(verdict)).not.toContain("private-judge-key");
  expect(vi.mocked(completeJudge).mock.calls[0]?.[1]).toBe(context.judge.model);
});

test("SimpleQA uses upstream NOT_ATTEMPTED fallback while transport failures remain errors", async () => {
  const record = { kind: "judge", instruction: "q", expected: "a" };
  vi.mocked(completeJudge).mockResolvedValue('unparseable output');
  expect(await simpleqaDefinition.verify(record, "", context, signal())).toMatchObject({ score: 0, passed: false, details: { grade: "NOT_ATTEMPTED" } });
  vi.mocked(completeJudge).mockImplementation(async () => { throw new Error("Judge timed out"); });
  await expect(simpleqaDefinition.verify(record, "", context, signal())).rejects.toThrow(/timed out/);
  vi.mocked(completeJudge).mockReset();
  await expect(simpleqaDefinition.verify(record, "", { dockerExecutable: "docker" }, signal())).rejects.toThrow(/judgeService/);
});

test("HealthBench sends the whole conversation, uses negative weights and keeps evidence", async () => {
  const task = healthbenchDefinition.prepare("health", { selection: "test", value: {
    prompt: [{ role: "user", content: "earlier context" }, { role: "assistant", content: "earlier response" }, { role: "user", content: "followup" }],
    rubrics: [{ criterion: "gives required facts", points: 2 }, { criterion: "makes a harmful claim", points: -4 }],
  } }, 0, null);
  vi.mocked(completeJudge).mockResolvedValue('{"criteria_met":true,"explanation":"fixture"}');
  const verdict = await healthbenchDefinition.verify(task.verification, "response", context, signal());
  expect(verdict).toMatchObject({ score: -1, passed: null, details: { achieved: -2, possible: 2, grades: [{ points: 2 }, { points: -4 }] } });
  expect(vi.mocked(completeJudge).mock.calls[0]?.[0]).toContain("earlier context");
  expect(vi.mocked(completeJudge).mock.calls[0]?.[0]).toContain("[2] gives required facts");
  expect(vi.mocked(completeJudge).mock.calls[0]?.[0]).toContain("assistant: response");
  expect(() => assertVerifyResult(verdict)).not.toThrow();
  vi.mocked(completeJudge).mockResolvedValue('{"criteria_met":"true"}');
  await expect(healthbenchDefinition.verify(task.verification, "response", context, signal())).rejects.toThrow(/rubric 0/);
});

test("HealthBench accepts a boolean grade without requiring an explanation", async () => {
  vi.mocked(completeJudge).mockResolvedValue('{"criteria_met":true}');
  expect(await healthbenchDefinition.verify({ kind: "judge", conversation: [{ role: "user", content: "question" }],
    criteria: [{ criterion: "answers the question", points: 1 }] }, "answer", context, signal()))
    .toMatchObject({ score: 1, details: { grades: [{ criteriaMet: true, explanation: "" }] } });
});

test("continuous quality scores complete without a correctness denominator", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.run.taskIds = ["pass"]; snapshot.records = snapshot.records.slice(0, 1); snapshot.pendingTaskIds = [];
  const record = snapshot.records[0];
  if (!record) throw new Error("fixture missing");
  record.verdict = { score: -0.5, passed: null, details: { protocol: "healthbench-custom-v1" } };
  finalizeAttemptOutcome(record);
  expect(() => assertAttemptRecord(record)).not.toThrow();
  expect(computeSuccessRate(snapshot)).toMatchObject({ applicable: false, denominator: null, rate: null });
  expect(await new QualityScoreMetrics().compute(snapshot)).toMatchObject({ measured: 1, rawMean: -0.5, mean: 0 });
  record.evaluationKind = "performance";
  expect(() => assertAttemptRecord(record)).toThrow();
});

test("quality metrics report zero attempted accuracy for all NOT_ATTEMPTED answers", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.run.taskIds = ["pass"]; snapshot.records = snapshot.records.slice(0, 1); snapshot.pendingTaskIds = [];
  const record = snapshot.records[0]!;
  record.verdict = { score: 0, passed: false, details: { protocol: "simpleqa-simple-evals-v1", grade: "NOT_ATTEMPTED" } };
  finalizeAttemptOutcome(record);
  expect(await new QualityScoreMetrics().compute(snapshot)).toMatchObject({ simpleqa: { accuracyGivenAttempted: 0, f1: 0, notAttemptedRate: 1 } });
});

test("quality metrics keep TriviaQA EM and partial token F1 separately", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  snapshot.run.taskIds = ["pass"]; snapshot.records = snapshot.records.slice(0, 1); snapshot.pendingTaskIds = [];
  const record = snapshot.records[0]!;
  record.verdict = { score: 0, passed: false, details: { method: "trivia", exactMatch: false, f1: 2 / 3 } };
  finalizeAttemptOutcome(record);
  expect(await new QualityScoreMetrics().compute(snapshot)).toMatchObject({ mean: 0, triviaqa: { measured: 1, exactMatch: 0, f1: 2 / 3 } });
});
