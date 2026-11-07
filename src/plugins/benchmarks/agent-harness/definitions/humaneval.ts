import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task } from "./records.js";
import { humanEvalRuntime } from "./scoring/code-execution.js";

export const humanevalDefinition: BenchmarkDefinition = {
  name: "humaneval",
  selections: ["test"],
  verificationRuntime: humanEvalRuntime,
  prepare(id, { value }, index) {
    const row = object(value, `HumanEval row ${index}`);
    const signature = required(row.prompt, "HumanEval prompt");
    return task(
      id,
      `Read the following function signature and docstring, and fully implement the function described. Your response should only contain the code for this function.\n\n${signature}`,
      { kind: "humaneval", signature, tests: required(row.test, "HumanEval tests"), entryPoint: required(row.entry_point, "HumanEval entry point") },
    );
  },
  verify() {
    throw new Error("HumanEval must be verified through its runtime lifecycle");
  },
};
