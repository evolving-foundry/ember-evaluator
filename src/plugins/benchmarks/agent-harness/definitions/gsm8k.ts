import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task, verificationRecord } from "./records.js";
import { scoreGsm8k } from "./scoring/answers.js";

export const gsm8kDefinition: BenchmarkDefinition = {
  name: "gsm8k",
  selections: ["test"],
  prepare(id, { value }, index) {
    const row = object(value, `GSM8K row ${index}`);
    const question = required(row.question, "GSM8K question");
    const sourceAnswer = required(row.answer, "GSM8K answer");
    const expected = sourceAnswer.match(/#### (-?[0-9.,]+)/)?.[1]?.trim().replaceAll(",", "");
    if (expected === undefined) throw new TypeError("GSM8K reference requires a numeric answer after '#### '");
    return task(
      id,
      `Solve the following math problem step by step. Put your final numerical answer after '#### '.\n\nProblem: ${question}`,
      { kind: "gsm8k", expected },
    );
  },
  verify(value, response) {
    const record = verificationRecord(value, "gsm8k");
    return scoreGsm8k(required(record.expected, "GSM8K answer"), response);
  },
};
