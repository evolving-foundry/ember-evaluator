import { expect, test } from "vitest";
import { mgsmDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/mgsm.js";

const context = {
  model: { name: "unused", endpoint: null, provider: null, api: null },
  auth: { value: "", reference: null },
  dockerExecutable: "docker",
};

test.each([
  [100, "100", true],
  [100, "10", false],
  [10, "100", false],
  [0, "10", false],
  [0, "0", true],
  [0, "No numeric answer available", false],
  [-100, "-10", false],
  [100, "100.000", true],
  ["100.000", "100", false],
  ["10.5000", "10.5", false],
  ["42.00500", "42.005", false],
  ["0.000", "0", false],
  ["123456789012345678900", "123456789012345678900.00", true],
  ["123456789012345678900", "12345678901234567890", false],
] as const)("MGSM preserves answer %s when grading %s", async (answer, response, passed) => {
  const prepared = mgsmDefinition.prepare("test:0", {
    value: { question: "Compute the requested value.", answer_number: answer }, selection: "en",
  }, 0, null);
  expect(prepared.verification).toMatchObject({ expected: String(answer) });
  expect(await mgsmDefinition.verify(prepared.verification, `Answer: ${response}`, context, new AbortController().signal))
    .toMatchObject({ score: passed ? 1 : 0, passed });
});
