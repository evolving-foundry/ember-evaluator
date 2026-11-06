import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, strings, task, verificationRecord } from "./records.js";
import { scoreTrivia } from "./scoring/answers.js";

export const triviaqaDefinition: BenchmarkDefinition = {
  name: "triviaqa",
  selections: ["test"],
  prepare(id, { value }, index) {
    const row = object(value, `TriviaQA row ${index}`);
    const answer = object(row.answer ?? null, "TriviaQA answer");
    const expected = required(answer.value, "TriviaQA answer value");
    const aliases = [
      ...new Set([
        ...strings(answer.normalized_aliases ?? [expected, ...strings(answer.aliases ?? [], "TriviaQA aliases")], "TriviaQA normalized aliases"),
        ...strings(answer.human_answers ?? [], "TriviaQA human answers"),
      ]),
    ];
    return task(
      id,
      `Answer with a short factual answer.\n\nQuestion: ${required(row.question, "TriviaQA question")}\nAnswer:`,
      { kind: "trivia", expected, aliases },
    );
  },
  verify(value, response) {
    const record = verificationRecord(value, "trivia");
    return scoreTrivia(strings(record.aliases, "TriviaQA aliases"), response);
  },
};
