import type { BenchmarkDefinition } from "../benchmark-definition.js";
import { completeJudge } from "../../../../../infrastructure/models/judge.js";
import { judgeEvidence, parseJudgeObject, requireJudge } from "./evidence.js";
import { object, required, verificationRecord } from "../records.js";
import { VerificationError } from "../../../../../core/errors/verification-error.js";
import { formatError, redactEvidence } from "../../../../../core/errors/diagnostics.js";
import { SIMPLEQA_GRADER_TEMPLATE, MATH_EQUALITY_TEMPLATE, HEALTHBENCH_GRADER_TEMPLATE } from "./judge-prompts.js";

export const scoreSimpleQa: BenchmarkDefinition["verify"] = async (value, response, context, signal) => {
  const record = verificationRecord(value, "judge");
  const { model, auth } = requireJudge(context);
  const values: Record<string, string> = { question: required(record.instruction, "SimpleQA question"), target: required(record.expected, "SimpleQA answer"), predicted_answer: response };
  const prompt = SIMPLEQA_GRADER_TEMPLATE.replace(/\{(question|target|predicted_answer)\}/g, (_match, key: string) => values[key] ?? "");
  const rawOutput = await completeJudge(prompt, model, auth, signal);
  const letter = rawOutput.match(/(A|B|C)/)?.[0] ?? "C";
  const grade = letter === "A" ? "CORRECT" : letter === "B" ? "INCORRECT" : "NOT_ATTEMPTED";
  return { score: grade === "CORRECT" ? 1 : 0, passed: grade === "CORRECT",
    details: redactEvidence({ ...judgeEvidence("simpleqa-simple-evals-v1", [prompt], context), grade, rawOutput }, [auth.value]) };
};

export const scoreMath500: BenchmarkDefinition["verify"] = async (value, response, context, signal) => {
  const record = verificationRecord(value, "math");
  const expected = required(record.expected, "MATH-500 answer");
  const { model, auth } = requireJudge(context);
  const extracted = response.match(/Answer\s*:\s*([^\n]+)/i)?.[1] ?? null;
  const prompt = MATH_EQUALITY_TEMPLATE.replace(/%\(expression([12])\)s/g,
    (_match, index: string) => index === "1" ? expected : extracted ?? "None");
  const rawOutput = await completeJudge(prompt, model, auth, signal);
  const passed = rawOutput.toLowerCase().trim() === "yes";
  return { score: passed ? 1 : 0, passed,
    details: redactEvidence({ ...judgeEvidence("math500-simple-evals-v1", [prompt], context), extracted, rawOutput }, [auth.value]) };
};

export const scoreHealthBench: BenchmarkDefinition["verify"] = async (value, response, context, signal) => {
  const record = verificationRecord(value, "judge");
  if (!Array.isArray(record.criteria) || !record.criteria.length) throw new TypeError("HealthBench requires nonempty rubrics");
  const rubrics = record.criteria.map((item, index) => {
    const rubric = object(item, `HealthBench rubric ${index}`);
    if (typeof rubric.points !== "number" || !Number.isFinite(rubric.points)) throw new TypeError(`Invalid HealthBench rubric ${index} points`);
    return { criterion: required(rubric.criterion, `HealthBench rubric ${index} criterion`), points: rubric.points };
  });
  const possible = rubrics.reduce((sum, rubric) => sum + Math.max(0, rubric.points), 0);
  if (possible <= 0) throw new TypeError("HealthBench requires positive rubric weight");
  const { model, auth } = requireJudge(context);
  if (!Array.isArray(record.conversation)) throw new TypeError("HealthBench conversation is missing");
  const conversation = record.conversation.map((item, index) => {
    const message = object(item, `HealthBench message ${index}`);
    return `${required(message.role, "HealthBench message role")}: ${required(message.content, "HealthBench message content")}`;
  });
  conversation.push(`assistant: ${response}`);
  const prompts: string[] = [];
  const grades = [];
  for (const [index, rubric] of rubrics.entries()) {
    const prompt = HEALTHBENCH_GRADER_TEMPLATE.replace("<<conversation>>", () => conversation.join("\n\n"))
      .replace("<<rubric_item>>", () => `[${rubric.points}] ${rubric.criterion}`);
    prompts.push(prompt);
    let rawOutput: string | null = null;
    try {
      signal.throwIfAborted();
      rawOutput = await completeJudge(prompt, model, auth, signal);
      const grade = parseJudgeObject(rawOutput);
      if (typeof grade.criteria_met !== "boolean") throw new TypeError("Invalid criterion judgment");
      grades.push({ ...rubric, criteriaMet: grade.criteria_met, explanation: typeof grade.explanation === "string" ? grade.explanation : "" });
    } catch (cause) {
      throw new VerificationError(`HealthBench judge failed for rubric ${index}`, redactEvidence({
        ...judgeEvidence("healthbench-simple-evals-v1", prompts, context), possible, grades,
        failedRubric: { index, ...rubric, rawOutput, error: formatError(cause, [auth.value]) },
      }, [auth.value]), { cause });
    }
  }
  const achieved = grades.reduce((sum, grade) => sum + (grade.criteriaMet ? grade.points : 0), 0);
  return { score: achieved / possible, passed: null,
    details: { ...judgeEvidence("healthbench-simple-evals-v1", prompts, context), possible, achieved, grades } };
};
