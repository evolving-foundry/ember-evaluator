import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { humanevalProgram } from "../../src/plugins/benchmarks/agent-harness/definitions/scoring/code-execution.js";

const available = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;
const marker = "HUMANEVAL_COMPLETED_controlled_test";

test.skipIf(!available).each([
  ["return 42", true], ["return 41", false],
  ["import sys; sys.exit(0)", false], ["import os; os._exit(0)", false],
  ["raise KeyboardInterrupt()", false], ["raise SystemExit(0)", false],
  ["print('user output'); return 42", true],
])("HumanEval requires check() to finish: %s", (body, passed) => {
  const source = `def candidate():\n    ${body}\n\ndef check(fn):\n    assert fn() == 42\ncheck(candidate)`;
  const result = spawnSync("python", ["-I", "-u", "-"], {
    input: humanevalProgram(source, marker), encoding: "utf8", timeout: 5000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status === 0 && result.stdout.trim() === marker).toBe(passed);
});

test.skipIf(!available || process.platform === "win32")("HumanEval test execution stops after three seconds", () => {
  const result = spawnSync("python", ["-I", "-u", "-"], {
    input: humanevalProgram("while True: pass", marker), encoding: "utf8", timeout: 6000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe(`${marker}:timeout`);
});
