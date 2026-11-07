import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { PythonRandom } from "./python-random.js";
import { object, required, strings, task, verificationRecord } from "./records.js";
import { scoreChoice } from "./scoring/choices.js";

export const gpqaDefinition: BenchmarkDefinition = {
  name: "gpqa",
  selections: ["test"],
  transformRows(rows) {
    const rng = new PythonRandom(0);
    return rows.map(({ value, selection }, index) => {
      const row = object(value, `GPQA row ${index}`);
      const choices = [
        required(row["Correct Answer"], "GPQA correct answer"),
        required(row["Incorrect Answer 1"], "GPQA incorrect answer"),
        required(row["Incorrect Answer 2"], "GPQA incorrect answer"),
        required(row["Incorrect Answer 3"], "GPQA incorrect answer"),
      ];
      const permutation = rng.sampleIndices(4, 4);
      const shuffled = permutation.map(choice => {
        const answer = choices[choice];
        if (answer === undefined) throw new RangeError("Invalid GPQA choice index");
        return answer;
      });
      const answer = "ABCD"[shuffled.indexOf(choices[0] ?? "")];
      if (answer === undefined) throw new Error("GPQA answer is missing after shuffle");
      return { selection, value: { ...row, __options: shuffled, __answer: answer } };
    });
  },
  prepare(id, { value }, index) {
    const row = object(value, `GPQA row ${index}`);
    const options = strings(row.__options, "GPQA shuffled choices");
    if (options.length !== 4) throw new TypeError("Invalid GPQA options");
    const prompt = `Answer the following multiple choice question. The last line of your response should be of the following format: 'Answer: $LETTER' (without quotes) where LETTER is one of ABCD. Think step by step before answering.\n\n${required(row.Question, "GPQA question")}\n\nA) ${options[0]}\nB) ${options[1]}\nC) ${options[2]}\nD) ${options[3]}`;
    return task(id, prompt, { kind: "multichoice", expected: required(row.__answer, "GPQA answer") });
  },
  verify(value, response) {
    const record = verificationRecord(value, "multichoice");
    return scoreChoice(required(record.expected, "GPQA answer"), response);
  },
};
