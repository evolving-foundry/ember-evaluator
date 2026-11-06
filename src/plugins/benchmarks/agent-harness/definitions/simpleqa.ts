import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task } from "./records.js";
import { scoreSimpleQa } from "./scoring/judge.js";

export const simpleqaDefinition: BenchmarkDefinition = {
  name: "simpleqa",
  selections: ["test"],
  prepare(id, { value }, index) {
    const row = object(value, `SimpleQA row ${index}`);
    const prompt = required(row.problem, "SimpleQA problem");
    return task(id, prompt, { kind: "judge", instruction: prompt, expected: required(row.answer, "SimpleQA answer") });
  },
  verify: scoreSimpleQa,
};
