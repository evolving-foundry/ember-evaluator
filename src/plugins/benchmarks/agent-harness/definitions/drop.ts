import type { JsonValue } from "../../../../core/contracts/task.js";
import type { BenchmarkDefinition, BenchmarkRecord } from "./benchmark-definition.js";
import { PythonRandom } from "./python-random.js";
import { object, required, strings, task, verificationRecord } from "./records.js";
import { scoreDropCandidates } from "./scoring/drop.js";

/** Keep annotations separate and preserve spans within each annotation. */
function answerSpans(value: JsonValue): string[] {
  const answer = object(value, "DROP annotation");
  if (typeof answer.number === "string" && answer.number) return [answer.number];
  const spans = strings(answer.spans ?? [], "DROP annotation spans");
  if (spans.length) return spans;
  const date = object(answer.date ?? null, "DROP annotation date");
  return [["day", "month", "year"].map(key => required(date[key], `DROP date ${key}`)).join(" ")];
}

function flattenDocument(value: JsonValue, selection: string): BenchmarkRecord[] {
  const document = object(value, "DROP document");
  return Object.values(document).flatMap(value => {
    const passage = object(value, "DROP passage record");
    if (!Array.isArray(passage.qa_pairs)) throw new TypeError("DROP qa_pairs are missing");
    return passage.qa_pairs.map(value => {
      const row = object(value, "DROP question record");
      return { selection, value: { ...row, passage: required(passage.passage, "DROP passage") } };
    });
  });
}

export const dropDefinition: BenchmarkDefinition = {
  name: "drop",
  selections: ["test"],
  transformRows(rows) {
    return rows.flatMap(row => flattenDocument(row.value, row.selection));
  },
  async loadSetup(source, lock, signal) {
    const examples: JsonValue[] = [];
    for await (const value of source.rows(lock, "train", signal))
      examples.push(...flattenDocument(value, "train").map(row => row.value));
    if (examples.length < 3) throw new Error("DROP training split has fewer than three examples");
    return examples;
  },
  prepare(id, { value }, index, setup) {
    const row = object(value, `DROP row ${index}`);
    if (!Array.isArray(setup)) throw new TypeError("DROP training rows are missing");
    const validated = row.validated_answers ?? [];
    if (!Array.isArray(validated)) throw new TypeError("DROP validated_answers must be an array");
    const candidates = [row.answer ?? null, ...validated].map(answerSpans).filter(spans => (spans[0] ?? "").trim());
    if (!candidates.length) throw new TypeError("DROP requires nonempty answer annotations");
    const rng = new PythonRandom(42 + index);
    const examples = rng.sampleIndices(setup.length, 3).map(position => {
      const example = object(setup[position] ?? null, "DROP training row");
      const spans = answerSpans(example.answer ?? null);
      const answer = spans.length > 1 ? JSON.stringify(spans) : spans[0] ?? "";
      return `\n---\n${required(example.passage, "DROP training passage")}\nQuestion: ${required(example.question, "DROP training question")}\nAnswer: ${answer}\n`;
    });
    const prompt = `You will be asked to read a passage and answer a question. Some examples of passages and Q&A are provided below.\n\n# Examples${examples.join("")}\n# Your Task\n\n---\n${required(row.passage, "DROP passage")}\nQuestion: ${required(row.question, "DROP question")}\nWrite the final answer on a line of the form "Answer: $ANSWER". If the answer requires multiple spans, use a JSON array of strings, for example Answer: ["Alice", "Bob"].\n`;
    return task(id, prompt, {
      kind: "drop", expected: (candidates[0] ?? []).join("; "), candidates,
      referenceGrouping: "official-annotations",
    });
  },
  verify(value, response) {
    const record = verificationRecord(value, "drop");
    if (record.referenceGrouping !== "official-annotations") throw new Error("DROP requires original grouped annotations; start a new run");
    if (!Array.isArray(record.candidates) || !record.candidates.length) throw new TypeError("DROP requires reference candidates");
    const result = scoreDropCandidates(record.candidates.map(candidate => strings(candidate, "DROP reference candidate")), response);
    return { ...result, details: { ...object(result.details, "DROP score details"), referenceGrouping: record.referenceGrouping } };
  },
};
