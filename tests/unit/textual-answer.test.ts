import { expect, test } from "vitest";
import { textualAnswer } from "../../src/plugins/benchmarks/agent-harness/definitions/records.js";

test("publishes a textual expected answer and its aliases", () => {
  expect(textualAnswer({ kind: "answer-line", expected: "70,000", pattern: "gsm8k" })).toBe("70,000");
  expect(textualAnswer({ kind: "fuzzy", expected: "42", aliases: ["42", "forty-two"] })).toEqual({
    expected: "42",
    aliases: ["42", "forty-two"],
  });
});

test("omits hidden tests, empty placeholders, and directory locators", () => {
  expect(textualAnswer({ kind: "humaneval", tests: "assert f(1) == 2", expected: "" })).toBeNull();
  expect(textualAnswer({ kind: "workbuddy-office", taskDir: "/tmp/task", datasetDir: "/tmp" })).toBeNull();
  expect(textualAnswer(null)).toBeNull();
});
