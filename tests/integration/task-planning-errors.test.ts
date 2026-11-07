import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const cases = (["batch", "pipeline"] as const).flatMap(mode =>
  (["TASK_DATA_INVALID", "BENCHMARK_UNSUPPORTED"] as const).flatMap(code =>
    (["continue", "abort"] as const).map(onError => ({ mode, code, onError }))));

test.each(cases)("$mode / $code plans remaining tasks and obeys onError=$onError", async ({ mode, code, onError }) => {
  const root = await mkdtemp(join(tmpdir(), "task-planning-errors-"));
  const { components, config, inputs, dispose } = harness(root, { transfer: true });
  cleanup.push(async () => { await dispose(); await rm(root, { recursive: true, force: true }); });
  config.experiment.run.preparation = { mode, concurrency: 2, ...(mode === "pipeline" ? { lookahead: 2 } : {}) };
  config.experiment.run.onError = onError;
  const planned: string[] = [];
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => {
    planned.push(args[0].id);
    if (args[0].id === "b") throw new EvaluatorError(code, "declared task planning failure");
    return prepare(...args);
  };
  components.benchmark.planRun = (refs, source, signal) =>
    planBenchmarkRun(components.benchmark, refs, source, signal, { version: "test", source: "test" }, 20);
  components.environment.materialize = vi.fn(async spec => spec);
  const open = components.environment.prepare.bind(components.environment);
  components.environment.prepare = async (...args) => ({ ...await open(...args), async quiesce() {} });

  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(planned).toEqual(["a", "b", "c"]);
  expect(snapshot.records.find(record => record.key.taskId === "b")).toMatchObject({
    executionStatus: "failed", scoreStatus: "invalid", solve: null, verdict: null,
    errors: [expect.objectContaining({ code, scope: "attempt" })],
  });
  if (onError === "continue") {
    expect(inputs.map(input => input.id).sort()).toEqual(["a", "c"]);
    expect(snapshot.records.filter(record => record.scoreStatus === "valid")).toHaveLength(2);
    expect(snapshot.pendingTaskIds).toEqual([]);
  } else {
    expect(inputs).toEqual([]);
    expect(components.environment.materialize).not.toHaveBeenCalled();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.pendingTaskIds).toEqual(["a", "c"]);
    expect(snapshot.run.status).toBe("error");
  }
});
