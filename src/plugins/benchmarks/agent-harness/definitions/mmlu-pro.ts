import type { BenchmarkDefinition } from "./benchmark-definition.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import { object, required, strings, task, verificationRecord } from "./records.js";
import { scoreMmluPro } from "./scoring/choices.js";

function formatExample(row: Record<string, JsonValue>, cot = "Let's think step by step."): string {
  const options = strings(row.options, "MMLU-Pro options").filter(option => option !== "N/A");
  if (options.length < 2 || options.length > 10) throw new TypeError("Invalid MMLU-Pro option count");
  return `Question: ${required(row.question, "MMLU-Pro question")}\nOptions: ${options.map((option, i) => `${"ABCDEFGHIJ"[i]}. ${option}\n`).join("")}Answer: ${cot.startsWith("A: ") ? cot.slice(3) : cot}\n\n`;
}

export const mmluProDefinition: BenchmarkDefinition = {
  name: "mmlu_pro",
  selections: ["test"],
  async loadSetup(source, lock, signal) {
    const examples: JsonValue[] = [];
    for await (const value of source.rows(lock, "validation", signal)) examples.push(value);
    if (!examples.length) throw new Error("MMLU-Pro validation examples are missing");
    return examples;
  },
  prepare(id, { value }, index, setup) {
    const row = object(value, `MMLU-Pro row ${index}`);
    const expected = required(row.answer, "MMLU-Pro answer");
    const category = required(row.category, "MMLU-Pro category");
    if (!Array.isArray(setup)) throw new TypeError("MMLU-Pro validation examples are missing");
    const examples = setup.map(value => object(value, "MMLU-Pro validation example")).filter(example => example.category === category);
    if (!examples.length) throw new Error(`MMLU-Pro has no validation examples for ${category}`);
    const prompt = `The following are multiple choice questions (with answers) about ${category}. Think step by step and then output the answer in the format of "The answer is (X)" at the end.\n\n`
      + examples.map(example => formatExample(example, required(example.cot_content, "MMLU-Pro example reasoning"))).join("")
      + formatExample(row);
    return task(id, prompt, { kind: "multichoice", expected });
  },
  verify(value, response) {
    const record = verificationRecord(value, "multichoice");
    return scoreMmluPro(required(record.expected, "MMLU-Pro answer"), response);
  },
};
