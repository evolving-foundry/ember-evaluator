import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task } from "./records.js";
import { scoreMath500 } from "./scoring/judge.js";
import { MATH_QUERY_TEMPLATE } from "./prompts.js";

export const math500Definition: BenchmarkDefinition = {
  name: "math500",
  selections: ["test"],
  prepare(id, { value }, index) {
    const row = object(value, `MATH-500 row ${index}`);
    const prompt = MATH_QUERY_TEMPLATE.replace("{Question}", () => required(row.problem, "MATH-500 problem"));
    return task(id, prompt, {
      kind: "math",
      expected: required(row.answer, "MATH-500 answer"),
    });
  },
  verify: scoreMath500,
};
