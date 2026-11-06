import { expect, test, vi } from "vitest";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import type { PreparedTask, TaskRef } from "../../src/core/contracts/task.js";
import type { SourceLock } from "../../src/core/contracts/task.js";
import { HarborTaskError } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/compatibility.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";

const source: SourceLock = { source: "test", revision: "1", files: [], metadata: null };
const signal = new AbortController().signal;

function task(id: string): PreparedTask {
  return { input: { id, prompt: "public" }, verification: null,
    solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null,
    preparationTimeoutSeconds: { solve: 80, verify: 120 } };
}
const refs = [{ id: "bad", recordKey: 0 }, { id: "good", recordKey: 1 }];
const policy = { version: "test", source: "test" };

test.each(["TASK_DATA_INVALID", "BENCHMARK_UNSUPPORTED"] as const)("explicit %s is saved while later tasks are still planned", async code => {
  const error = new EvaluatorError(code, "declared task failure");
  const prepare = vi.fn(async (ref: TaskRef): Promise<PreparedTask> => {
    if (ref.id === "bad") throw error;
    return task(ref.id);
  });
  const plan = await planBenchmarkRun({ prepare }, refs, source, signal, policy, 600);
  expect(prepare.mock.calls.map(call => call[0].id)).toEqual(["bad", "good"]);
  expect(plan.tasks.map(task => task.input.id)).toEqual(["good"]);
  expect(plan.preparationFailures).toMatchObject([{ taskId: "bad", failure: { code, scope: "attempt", action: "finalize", message: error.message } }]);
  expect(plan.preparation.defaultTimeoutSeconds).toBe(600);
  expect(plan.tasks[0]?.preparationTimeoutSeconds).toEqual({ solve: 80, verify: 120 });
});

test.each(["TASK_DATA_INVALID", "BENCHMARK_UNSUPPORTED"] as const)("Harbor emits registered %s directly", async code => {
  const plan = await planBenchmarkRun({ async prepare(ref) {
    if (ref.id === "bad") throw new HarborTaskError(code, "task failure");
    return task(ref.id);
  } }, refs, source, signal, policy, 600);
  expect(plan.tasks.map(task => task.input.id)).toEqual(["good"]);
  expect(plan.preparationFailures).toMatchObject([{ taskId: "bad", failure: { code } }]);
  expect(plan.preparationFailures?.[0]?.failure.details).not.toHaveProperty("originalCode");
});

test.each([
  new EvaluatorError("SOURCE_CHANGED", "locked source changed"),
  new EvaluatorError("CONFIG_INVALID", "invalid component configuration"),
  new EvaluatorError("DATA_FETCH_FAILED", "whole source failed", {}, { cause: new Error("ECONNRESET") }),
  new EvaluatorError("ENV_RESOURCE_EXHAUSTED", "node exhausted"),
  new EvaluatorError("INTERNAL_ERROR", "unknown component failure"),
  new Error("TASK_DATA_INVALID appears only in a message"),
  new Error("wrapped task failure", { cause: new EvaluatorError("TASK_DATA_INVALID", "nested code only") }),
  Object.assign(new Error("unsupported implementation"), { code: "UNSUPPORTED_NEW_PLUGIN" }),
  Object.assign(new Error("unknown code"), { code: "UNKNOWN_TASK_FAILURE" }),
  new TypeError("invalid task shape"),
  new HarborTaskError("TASK_DATA_INVALID", "wrapped source failure", { cause: new EvaluatorError("SOURCE_CHANGED", "source changed") }),
])("non-task planning error remains fatal: %s", async error => {
  const prepare = vi.fn(async (): Promise<PreparedTask> => { throw error; });
  await expect(planBenchmarkRun({ prepare }, refs, source, signal, policy, 600)).rejects.toBe(error);
  expect(prepare).toHaveBeenCalledTimes(1);
});

test("code getters are not evaluated to grant task-local recovery", async () => {
  const error = new Error("third-party exception");
  const getter = vi.fn(() => "TASK_DATA_INVALID");
  Object.defineProperty(error, "code", { get: getter });
  await expect(planBenchmarkRun({ async prepare() { throw error; } }, refs, source, signal, policy, 600)).rejects.toBe(error);
  expect(getter).not.toHaveBeenCalled();
});

test("confirmed task-source network failures still permit later planning", async () => {
  const plan = await planBenchmarkRun({ async prepare(ref) {
    if (ref.id === "bad") throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return task(ref.id);
  } }, refs, source, signal, policy, 600);
  expect(plan.tasks.map(task => task.input.id)).toEqual(["good"]);
  expect(plan.preparationFailures).toMatchObject([{ taskId: "bad", failure: { code: "NETWORK_FAILURE", details: { networkStage: "dataset" } } }]);
});

test("cancellation takes precedence over an explicitly task-local error", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel planning");
  const prepare = vi.fn(async (): Promise<PreparedTask> => {
    controller.abort(reason);
    throw new EvaluatorError("TASK_DATA_INVALID", "invalid task after cancellation");
  });
  await expect(planBenchmarkRun({ prepare }, refs, source, controller.signal, policy, 600)).rejects.toBe(reason);
  expect(prepare).toHaveBeenCalledTimes(1);
});

test("task-local planning errors are isolated, while source errors remain fatal", async () => {
  const refs = [{ id: "gpu", recordKey: 0 }];
  const plan = await planBenchmarkRun({ async prepare() {
    throw new HarborTaskError("BENCHMARK_UNSUPPORTED", "GPU required");
  } }, refs, source, signal, { version: "test", source: "test" }, 600);
  expect(plan.tasks).toEqual([]);
  expect(plan.preparationFailures).toMatchObject([{ taskId: "gpu", failure: { code: "BENCHMARK_UNSUPPORTED" } }]);
  await expect(planBenchmarkRun({ async prepare() { throw new Error("Source changed"); } },
    refs, source, signal, { version: "test", source: "test" }, 600)).rejects.toThrow("Source changed");
});

test("planning preserves per-environment declarations and a separate default, regardless of selection size", async () => {
  const plan = await planBenchmarkRun({ async prepare(ref) { return task(ref.id); } }, refs, source, signal, policy, 1800);
  expect(plan.preparation).toEqual({ defaultTimeoutSeconds: 1800 });
  expect(plan.tasks.map(task => task.preparationTimeoutSeconds)).toEqual([
    { solve: 80, verify: 120 }, { solve: 80, verify: 120 },
  ]);
  expect(plan.policy).toEqual(policy);
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147484])("invalid preparation default %s is rejected", async limit => {
  await expect(planBenchmarkRun({ async prepare(ref) { return task(ref.id); } }, refs, source, signal, policy, limit))
    .rejects.toThrow(/preparation timeout/i);
});

test("Harbor rejects the removed batch multiplier with migration guidance", () => {
  expect(() => parseHarborConfig({ environmentBuildTimeoutMultiplier: 4 })).toThrow(/run.preparation.roundTimeoutSeconds/);
  expect(parseHarborConfig({}).defaults.buildTimeoutSeconds).toBe(600);
});
