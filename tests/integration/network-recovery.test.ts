import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { renderMarkdown } from "../../src/plugins/reporters/markdown.js";
import { aggregateMetrics } from "../../src/plugins/metrics/aggregate.js";
import { controlTransaction, submitRetry } from "../../src/application/retry-control/mailbox.js";
import { locateRun } from "../../src/infrastructure/filesystem/run-index.js";
import { isEvaluationComplete } from "../../src/core/results/evaluation-outcome.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "network-recovery-"));
  const value = harness(root);
  cleanups.push(async () => { await value.components.dispose(); await rm(root, { recursive: true, force: true }); });
  value.config.experiment.run.onError = "continue";
  return value;
}
test.each(["solve", "verify"] as const)("a %s image build failure never starts a second attempt", async phase => {
  const root = await mkdtemp(join(tmpdir(), "build-no-task-retry-"));
  const value = harness(root, { transfer: true });
  cleanups.push(async () => { await value.components.dispose(); await rm(root, { recursive: true, force: true }); });
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.onError = "continue";
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  let builds = 0;
  value.components.environment.prepare = async (...args) => {
    if (args[2] === phase) {
      builds++;
      throw new EvaluatorError("ENV_IMAGE_BUILD_FAILED", "HTTP 503", { operation: "build" });
    }
    return prepare(...args);
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(builds).toBe(1);
  expect(value.inputs).toHaveLength(phase === "solve" ? 0 : 1);
  expect(result.attemptHistory).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ scoreStatus: "invalid", verdict: null,
    errors: [expect.objectContaining({ code: "ENV_IMAGE_BUILD_FAILED", retryable: false, action: "finalize" })] });
  const directory = join(value.config.experiment.output.directory, result.run.runId);
  await value.components.store.close();
  await expect(runEngine({ ...value, signal: new AbortController().signal, resumeDirectory: directory,
    retryTaskIds: ["a"] })).rejects.toThrow("without a current network failure");
});

test("100 tasks / 25 slots / three network failures yield 100 attempts and 97 scored results", async () => {
  const value = await fixture(); value.components.scheduler = new LocalScheduler(25);
  value.components.benchmark.enumerate = async function* () { for (let id = 0; id < 100; id++) yield { id: String(id), recordKey: id }; };
  const solve = value.components.solver.solve;
  const counts = new Map<string, number>();
  value.components.solver.solve = async (...args) => {
    const id = args[0].id, count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
    if (Number(id) < 3 && count === 1) throw new Error("ECONNRESET");
    return solve(...args);
  };
  value.components.benchmark.verify = async task => ({ score: Number(task.input.id) < 3 ? 0 : 1, passed: Number(task.input.id) >= 3, details: {} });
  const progress: ProgressEvent[] = [];
  const snapshot = await runEngine({ ...value, signal: new AbortController().signal,
    onProgress: event => { if (event.phase === "task") progress.push(event); } });
  expect(snapshot.run.status).toBe("error"); expect(snapshot.run.taskIds).toHaveLength(100);
  expect(snapshot.attemptHistory).toHaveLength(100); expect(snapshot.records).toHaveLength(100);
  expect(snapshot.records.filter(isEvaluationComplete)).toHaveLength(97);
  expect(snapshot.records.flatMap(record => record.errors)).toHaveLength(3);
  expect(snapshot.records.filter(record => record.verdict?.score === 0)).toHaveLength(0);
  expect(progress.at(-1)?.summary).toMatchObject({ total: 100, completed: 100 });
  expect(progress.at(-1)?.message).toContain("progress 100/100");
  expect(progress.every(event => (event.summary?.completed ?? 0) <= 100)).toBe(true);
  const metrics = await aggregateMetrics(snapshot, []);
  expect(metrics["attempt-accounting"]).toMatchObject({ attempts: 100, cost: { unknownAttempts: 100 } });
  expect(renderMarkdown(snapshot, metrics)).toContain("NETWORK_FAILURE");
}, 30_000);
test("terminal retry keeps run ID, never redoes zero scores and updates the report without stale errors", async () => {
  const value = await fixture(); const solve = value.components.solver.solve; let fail = true;
  value.components.solver.solve = async (...args) => { if (args[0].id === "a" && fail) throw new Error("ECONNRESET"); return solve(...args); };
  value.components.benchmark.verify = async () => ({ score: 0, passed: false, details: {} });
  const first = await runEngine({ ...value, signal: new AbortController().signal });
  const directory = join(value.config.experiment.output.directory, first.run.runId);
  expect(await locateRun(first.run.runId)).toBe(await realpath(directory));
  await value.components.store.saveReportBundle(first.digest, {}, renderMarkdown(first, {}), []);
  await value.components.store.close(); fail = false;
  const request = await submitRetry(directory, { taskIds: ["a"], requestId: "terminal" });
  const final = await runEngine({ ...value, signal: new AbortController().signal, resumeDirectory: directory, retryTaskIds: ["a"], retryRequestId: request.request.requestId });
  expect(final.run.runId).toBe(first.run.runId); expect(final.run.status).toBe("completed");
  expect(final.attemptHistory).toHaveLength(4);
  await value.components.store.saveReportBundle(final.digest, {}, renderMarkdown(final, {}), []);
  expect(await readFile(join(directory, "report.md"), "utf8")).not.toContain("NETWORK_FAILURE");
  expect(final.attemptHistory?.some(attempt => attempt.record?.errors.some(error => error.code === "NETWORK_FAILURE"))).toBe(true);
  expect(await readdir(directory)).not.toContain("reports");
  await value.components.store.close();
  await expect(runEngine({ ...value, signal: new AbortController().signal, resumeDirectory: directory, retryTaskIds: ["b"] })).rejects.toThrow("without a current network failure");
});
test("active manual request is replay-idempotent and remains in the original coordinator", async () => {
  const value = await fixture(); const solve = value.components.solver.solve;
  const held = Promise.withResolvers<void>(); const failed = Promise.withResolvers<void>();
  let calls = 0;
  value.components.solver.solve = async (...args) => {
    if (args[0].id === "a" && ++calls === 1) throw new Error("ECONNRESET");
    if (args[0].id === "b") await held.promise;
    return solve(...args);
  };
  const running = runEngine({ ...value, signal: new AbortController().signal, onProgress: event => {
    if (event.phase === "task" && event.taskId === "a") failed.resolve();
  } });
  await failed.promise;
  const snapshot = await value.components.store.snapshot();
  const directory = join(value.config.experiment.output.directory, snapshot.run.runId);
  const first = await submitRetry(directory, { taskIds: ["a"], requestId: "active" });
  const replay = await submitRetry(directory, { taskIds: ["a"], requestId: "active" });
  expect(first.active).toBe(true); expect(replay.request.requestId).toBe(first.request.requestId);
  held.resolve(); const final = await running;
  expect(final.run.status).toBe("completed"); expect(final.attemptHistory).toHaveLength(4); expect(calls).toBe(2);
  await controlTransaction(directory, async state => { expect(state.requests.filter(item => item.requestId === "active")).toHaveLength(1); expect(state.accepting).toBe(false); });
});
test("initial download failure leaves a Run ID with no invented tasks and recovery locks that same source", async () => {
  const value = await fixture(); let fail = true;
  const resolve = value.components.benchmark.resolveSource;
  value.components.benchmark.resolveSource = async (...args) => { if (fail) throw Object.assign(new Error("dataset connect failed"), { code: "ECONNRESET" }); return resolve(...args); };
  const first = await runEngine({ ...value, signal: new AbortController().signal });
  expect(first.run.source).toBeNull(); expect(first.run.failure?.code).toBe("NETWORK_FAILURE"); expect(first.run.taskIds).toEqual([]);
  expect(renderMarkdown(first, {})).toContain("任务集合未确定");
  const directory = join(value.config.experiment.output.directory, first.run.runId);
  await value.components.store.close(); fail = false;
  const final = await runEngine({ ...value, signal: new AbortController().signal, resumeDirectory: directory });
  expect(final.run.runId).toBe(first.run.runId); expect(final.run.source).not.toBeNull(); expect(final.run.failure).toBeNull(); expect(final.run.status).toBe("completed");
});

test("a fatal store write drains a coordinator waiting for its final active result", async () => {
  const value = await fixture(); value.config.experiment.run.taskIds = ["a"];
  value.components.store.commit = async () => { throw new Error("injected write failure"); };
  await expect(runEngine({ ...value, signal: new AbortController().signal })).rejects.toThrow("Cannot persist attempt");
  expect((await value.components.store.snapshot()).run.status).toBe("error");
}, 3000);
