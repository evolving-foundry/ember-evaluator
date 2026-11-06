import { expect, test } from "vitest";
import { parseWarmupSummary } from "../../src/application/ray/warmup-result.js";
import { classifyError } from "../../src/core/errors/classify.js";

const summary = { status: "ready", taskIds: ["a"], readyTaskIds: ["a"], failures: [], preparationRounds: [],
  placements: [{ taskId: "a", nodeId: "node" }], durationMs: 1 };

test("remote warmup summary keeps placement and task outcomes", () => {
  expect(parseWarmupSummary(summary)).toEqual(summary);
  const failed = { ...summary, status: "error", readyTaskIds: [],
    failures: [{ taskId: "a", failure: classifyError(new Error("failed"), { phase: "prepare" }) }] };
  expect(parseWarmupSummary(failed)).toEqual(failed);
});

test.each([
  { ...summary, readyTaskIds: [] }, { ...summary, taskIds: ["a", "a"] }, { ...summary, status: "error" },
  { ...summary, placements: [{ taskId: "other", nodeId: "node" }] },
  { ...summary, placements: [...summary.placements, ...summary.placements] },
  { ...summary, durationMs: -1 }, { ...summary, preparationRounds: [{}] },
  { ...summary, failures: [{ taskId: "a", failure: { message: "malformed" } }] },
])("malformed warmup summary is not reported as success", value => {
  expect(() => parseWarmupSummary(value)).toThrow();
});
