import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { object, required, task, verificationRecord } from "./records.js";
import { scoreNumeric } from "./scoring/answers.js";
import { MGSM_INSTRUCTIONS, MGSM_ANSWER_PREFIXES } from "./prompts.js";

const LANGUAGES = ["en", "de", "fr", "es", "ru", "zh", "ja", "th", "te", "bn", "sw"] as const;

export const mgsmDefinition: BenchmarkDefinition = {
  name: "mgsm",
  selections: LANGUAGES,
  prepare(id, { value, selection: language }, index) {
    const row = object(value, `MGSM row ${index}`);
    const answer = row.answer_number;
    if (typeof answer !== "number" && typeof answer !== "string") throw new TypeError("MGSM answer_number is invalid");
    const expected = String(answer);
    const instruction = MGSM_INSTRUCTIONS[language];
    if (!instruction) throw new TypeError(`Unsupported MGSM language ${language}`);
    return task(id, instruction.replace("{input}", () => required(row.question, "MGSM question")), {
      kind: "numeric",
      expected,
      language,
    });
  },
  verify(value, response) {
    const record = verificationRecord(value, "numeric");
    const language = required(record.language, "MGSM language");
    const prefix = MGSM_ANSWER_PREFIXES[language];
    if (!prefix) throw new TypeError(`Unsupported MGSM language ${language}`);
    return scoreNumeric(required(record.expected, "MGSM answer"), response, prefix);
  },
};
