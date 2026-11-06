import type { BenchmarkDefinition } from "./benchmark-definition.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import { createHash } from "node:crypto";
import { object, required, strings, task, verificationRecord } from "./records.js";
import { scoreMmluLogprobs } from "./scoring/logprobs.js";

/** Answer-only instruction; the five dev examples keep the plain "Answer:" cue. */
const ANSWER_INSTRUCTION = "Answer with exactly one letter: A, B, C, or D.\nDo not provide an explanation.\n\n";

function question(row: Record<string, JsonValue>, includeAnswer: boolean): string {
  const choices = strings(row.choices, "MMLU choices");
  const answer = row.answer;
  if (choices.length !== 4 || typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 3)
    throw new TypeError("Invalid MMLU choices or answer");
  const prompt = required(row.question, "MMLU question") + choices.map((text, index) => `\n${"ABCD"[index]}. ${text}`).join("") + "\nAnswer:";
  return includeAnswer ? `${prompt} ${"ABCD"[answer]}\n\n` : prompt;
}

export const mmluDefinition: BenchmarkDefinition = {
  name: "mmlu",
  selections: ["test"],
  async loadSetup(source, lock, signal) {
    const subjects: Record<string, JsonValue[]> = {};
    for await (const value of source.rows(lock, "dev", signal)) {
      const row = object(value, "MMLU dev row");
      const subject = required(row.subject, "MMLU dev subject");
      question(row, true);
      const examples = Object.hasOwn(subjects, subject) ? subjects[subject] : undefined;
      if (examples) examples.push(value);
      else Object.defineProperty(subjects, subject, { value: [value], enumerable: true });
    }
    return subjects;
  },
  prepare(id, { value }, index, setup) {
    const row = object(value, `MMLU row ${index}`);
    const subject = required(row.subject, "MMLU subject");
    const subjects = object(setup, "MMLU dev examples");
    const examples = Object.hasOwn(subjects, subject) ? subjects[subject] : undefined;
    if (!Array.isArray(examples) || examples.length < 5) throw new TypeError(`MMLU requires five dev examples for ${subject}`);
    // format_subject() in the original adds a space before each underscore-separated word.
    const heading = subject.split("_").map(word => ` ${word}`).join("");
    const prompt = `The following are multiple choice questions (with answers) about ${heading}.\n\n`
      + examples.slice(0, 5).map(value => question(object(value, "MMLU dev example"), true)).join("")
      + `${ANSWER_INSTRUCTION}Question: ${question(row, false)}`;
    return task(id, prompt, { kind: "mmlu-logprobs", expected: "ABCD"[Number(row.answer)] ?? "", subject, shots: 5,
      promptSha256: createHash("sha256").update(prompt).digest("hex") });
  },
  verify(value, _response, _context, signal, observations) {
    signal.throwIfAborted();
    const record = verificationRecord(value, "mmlu-logprobs");
    const result = scoreMmluLogprobs(required(record.expected, "MMLU answer"), required(record.promptSha256, "MMLU prompt digest"), observations);
    return { ...result, details: { ...object(result.details, "MMLU score details"), subject: record.subject ?? null, shots: record.shots ?? null } };
  },
};
