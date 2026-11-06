import { beforeEach, expect, test, vi } from "vitest";
import { completeJudge } from "../../src/infrastructure/models/judge.js";
import { math500Definition } from "../../src/plugins/benchmarks/agent-harness/definitions/math500.js";
import { MATH_QUERY_TEMPLATE } from "../../src/plugins/benchmarks/agent-harness/definitions/prompts.js";
import { MATH_EQUALITY_TEMPLATE } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/judge-prompts.js";
import { openPluginRegistry } from "../../src/application/plugins/runtime.js";
import { loadConfig } from "../../src/application/config.js";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

vi.mock("../../src/infrastructure/models/judge.js", () => ({ completeJudge: vi.fn() }));
beforeEach(() => vi.mocked(completeJudge).mockReset());
const context = { dockerExecutable: "docker", judgeService: "judge", judge: {
  model: { name: "math-judge", endpoint: "https://judge.invalid", provider: null, api: "openai-completions" },
  auth: { value: "math-judge-secret", reference: "JUDGE_KEY" },
} };
const signal = () => new AbortController().signal;

test("MATH-500 templates match the pinned upstream bytes", () => {
  expect(createHash("sha256").update(MATH_QUERY_TEMPLATE).digest("hex")).toBe("231d269274b6a04711d192c935b7a4785da99e6823afbc817972a1d51f48425e");
  expect(createHash("sha256").update(MATH_EQUALITY_TEMPLATE).digest("hex")).toBe("c9385e2f8120f01b098ea7c3b265535f797a65d8d7b37df4833fa38b51f50d2f");
});

test.each([
  ["2x+3", "3+2x"], ["3/2", "1.5"], ["x^2+2x+1", "(x+1)^2"],
  ["a", "A"], ["42", "42"],
])("MATH-500 delegates %s / %s to the selected equality judge", async (expected, answer) => {
  vi.mocked(completeJudge).mockResolvedValue("Yes");
  const result = await math500Definition.verify({ kind: "math", expected }, `Answer: ${answer}`, context, signal());
  expect(result).toMatchObject({ score: 1, passed: true, details: { protocol: "math500-simple-evals-v1", extracted: answer, rawOutput: "Yes", judgeModel: "math-judge", officialComparable: false } });
  expect(completeJudge).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`Expression 1: ${expected}\n    Expression 2: ${answer}`), context.judge.model, context.judge.auth, expect.any(AbortSignal));
});

test.each([
  ["Yes", true], [" YES\n", true], ["yes", true], ["No", false], ["yes.", false],
  ["Yes, they are equal", false], ["```yes```", false], ["", false],
])("MATH-500 follows upstream exact Yes parsing: %j", async (output, passed) => {
  vi.mocked(completeJudge).mockResolvedValue(output);
  expect(await math500Definition.verify({ kind: "math", expected: "a" }, "Answer: A", context, signal()))
    .toMatchObject({ score: passed ? 1 : 0, passed });
});

test.each([
  ["Work\nAnswer: first\nAnswer: last", "first"],
  ["Answer:   spaced answer   ", "spaced answer   "],
  ["Final answer only", null],
])("MATH-500 retains upstream extraction and missing-answer behavior: %s", async (response, extracted) => {
  vi.mocked(completeJudge).mockResolvedValue("No");
  expect(await math500Definition.verify({ kind: "math", expected: "reference" }, response, context, signal()))
    .toMatchObject({ score: 0, details: { extracted } });
  expect(vi.mocked(completeJudge).mock.calls[0]?.[0]).toContain(`Expression 2: ${extracted ?? "None"}`);
});

test("MATH-500 substitutions preserve literal placeholders and dollar sequences in answers", async () => {
  vi.mocked(completeJudge).mockResolvedValue("No");
  const expected = "%(expression2)s $&", response = "Answer: %(expression1)s $&";
  await math500Definition.verify({ kind: "math", expected }, response, context, signal());
  expect(vi.mocked(completeJudge).mock.calls[0]?.[0]).toContain("Expression 1: %(expression2)s $&\n    Expression 2: %(expression1)s $&");
});

test("MATH-500 preserves service errors and requires an explicit judge", async () => {
  const record = { kind: "math", expected: "42" };
  vi.mocked(completeJudge).mockImplementation(async () => { throw new Error("Judge unavailable"); });
  const failed = await Promise.resolve(math500Definition.verify(record, "Answer: 42", context, signal())).catch((cause: unknown) => cause);
  expect(failed).toBeInstanceOf(Error);
  expect(failed).toHaveProperty("message", "Judge unavailable");
  vi.mocked(completeJudge).mockReset();
  await expect(math500Definition.verify(record, "Answer: 42", { dockerExecutable: "docker" }, signal())).rejects.toThrow(/judgeService/);
});

test("MATH-500 uses the complete upstream query template and redacts judge credentials", async () => {
  const task = math500Definition.prepare("task", { selection: "test", value: { problem: "Compute {Question} and $&", answer: "42" } }, 0, null);
  expect(task.input.prompt).toBe(MATH_QUERY_TEMPLATE.replace("{Question}", () => "Compute {Question} and $&"));
  vi.mocked(completeJudge).mockResolvedValue("No math-judge-secret");
  expect(JSON.stringify(await math500Definition.verify(task.verification, "Answer: 41", context, signal()))).not.toContain("math-judge-secret");
});

test("math500 configuration requires a named judge service", async () => {
  const registry = await openPluginRegistry();
  try {
    expect(() => registry.ctx.evaluator.prepare("benchmark", { name: "math500", config: {} })).toThrow(/judgeService/);
    expect(() => registry.ctx.evaluator.prepare("benchmark", { name: "math500", config: { judgeService: "grader" } })).not.toThrow();
  } finally { await registry.dispose(); }
});

test("MATH-500 example resolves independent solver and judge credentials", async () => {
  const env = { MODEL_NAME: "solver", MODEL_ENDPOINT: "https://solver.invalid", MODEL_API_KEY: "solver-secret",
    JUDGE_NAME: "grader", JUDGE_ENDPOINT: "https://judge.invalid", JUDGE_API_KEY: "judge-secret" };
  const path = resolve("playbook/math500/math500-simpleagent.yaml");
  const loaded = await loadConfig(path, {}, env);
  expect(loaded.experiment.benchmark.config.judgeService).toBe("judge");
  expect(loaded.auths.default?.value).toBe("solver-secret");
  expect(loaded.auths.judge?.value).toBe("judge-secret");
  expect(JSON.stringify(loaded.persisted)).not.toContain("judge-secret");
  const { JUDGE_API_KEY: _key, ...withoutJudge } = env;
  await expect(loadConfig(path, {}, withoutJudge)).rejects.toThrow(/JUDGE_API_KEY/);
});
