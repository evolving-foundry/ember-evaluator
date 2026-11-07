import { attemptTimeoutKind } from "../../src/core/results/evaluation-outcome.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { runEngine } from "../../src/application/run-engine.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { HarborScoreMetrics } from "../../src/plugins/metrics/harbor-score.js";
const harborScore = new HarborScoreMetrics({ dimensions: [] });
import { renderMarkdown } from "../../src/plugins/reporters/markdown.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun, trajectoryLines } from "../fixtures/results/store-fixture.js";

const fixtures: { root: string; value: ReturnType<typeof harness> }[] = [];
afterEach(async () => {
  for (const { root, value } of fixtures.splice(0)) {
    await value.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(options: Parameters<typeof harness>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "timeout-outcomes-"));
  const value = harness(root, options);
  fixtures.push({ root, value });
  value.components.scheduler = new LocalScheduler(1);
  return value;
}
async function untilAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

test.each([
  { phase: "solve", taskLimit: 0.01, override: 0.3, status: "completed" },
  { phase: "solve", taskLimit: 0.3, override: 0.01, status: "agent_timeout" },
  { phase: "verify", taskLimit: 0.01, override: 0.3, status: "completed" },
  { phase: "verify", taskLimit: 0.3, override: 0.01, status: "failed" },
] as const)("explicit $phase ceiling $override replaces task ceiling $taskLimit", async ({ phase, taskLimit, override, status }) => {
  const value = await fixture();
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 2;
  value.config.experiment.run[phase === "solve" ? "solveTimeoutSeconds" : "verifyTimeoutSeconds"] = override;
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { [phase]: taskLimit } });
  if (phase === "solve") {
    const solve = value.components.solver.solve.bind(value.components.solver);
    value.components.solver.solve = async (...args) => { await delay(70, undefined, { signal: args[2].signal }); return solve(...args); };
  } else {
    const verify = value.components.benchmark.verify.bind(value.components.benchmark);
    value.components.benchmark.verify = async (...args) => { await delay(70, undefined, { signal: args[3] }); return verify(...args); };
  }
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.records[0]?.executionStatus).toBe(status);
  if (status === "agent_timeout") expect(result.records[0]).toMatchObject({ scoreStatus: "valid", verdict: null });
  if (status === "failed") expect(result.records[0]).toMatchObject({ scoreStatus: "invalid", verdict: null });
});

test("a verify-only override leaves the task's solve deadline in effect", async () => {
  const value = await fixture({ wait: true });
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.verifyTimeoutSeconds = 2;
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { solve: 0.03 } });
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.records[0]).toMatchObject({ executionStatus: "agent_timeout", verdict: null });
  expect(value.events).not.toContain("verify");
});

test("a long phase override cannot extend a shorter whole-task deadline", async () => {
  const value = await fixture({ wait: true });
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 0.05;
  value.config.experiment.run.solveTimeoutSeconds = 100;
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.records[0]).toMatchObject({ executionStatus: "agent_timeout", verdict: null });
  expect(result.records[0]!.durationMs).toBeLessThan(2000);
});

test("runTask without an explicit whole-task budget can solve past the old 300-second default", async () => {
  const value = await fixture();
  await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: ["a"] }, {});
  const solve = value.components.solver.solve.bind(value.components.solver);
  value.components.solver.solve = async (...args) => { const result = await solve(...args); vi.advanceTimersByTime(301_000); return result; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const record = await runTask({ runId: storeRun.runId, taskId: "a", attemptId: "default-budget", ref: { id: "a", recordKey: "a" }, configFingerprint: storeRun.configFingerprint },
      value.components, source, new AbortController().signal);
    expect(record.executionStatus).toBe("completed");
  } finally { vi.useRealTimers(); }
});

test("Agent solve deadline is a zero-score evaluation, refills the slot and is skipped on resume", async () => {
  const value = await fixture();
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { solve: 0.03 } });
  const solve = value.components.solver.solve.bind(value.components.solver);
  const calls: string[] = [];
  value.components.solver.solve = async (...args) => {
    calls.push(args[0].id);
    if (args[0].id === "a") await untilAborted(args[2].signal);
    return solve(...args);
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(calls).toEqual(["a", "b", "c"]);
  expect(result.run.status).toBe("completed");
  expect(result.records[0]).toMatchObject({ executionStatus: "agent_timeout", solve: null, verdict: null });
  expect(computeSuccessRate(result)).toMatchObject({ selected: 3, denominator: 3, invalid: 0, passed: 2, rate: 2 / 3 });
  expect((await harborScore.compute(result)).meanReward).toBe(2 / 3);
  expect(renderMarkdown(result, {})).toContain("| a | timeout (agent) | 0 |");
  expect(renderMarkdown(result, {})).not.toContain("**未完成");
  const attempts = await value.components.store.listAttempts();
  expect(planResume(result.run, attempts, result.run.configFingerprint).restartTaskIds).toEqual([]);
  await value.components.store.close();
  const resumed = await runEngine({ ...value, signal: new AbortController().signal,
    resumeDirectory: join(value.config.experiment.output.directory, result.run.runId) });
  expect(resumed.run.status).toBe("completed");
  expect(calls).toHaveLength(3);
});

test("a task-wide deadline reached during solving is also an Agent timeout", async () => {
  const value = await fixture();
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 0.06;
  value.components.solver.solve = async (_input, _session, context) => {
    await untilAborted(context.signal); throw new Error("unreachable");
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(result.records[0]).toMatchObject({ executionStatus: "agent_timeout", });
  expect(await value.components.store.listAttempts()).toHaveLength(1);
});

test.each(["partial", "missing-session", "missing-trajectory", "export-failure"] as const)(
  "Agent timeout with %s evidence keeps independent collection failures separate",
  async evidence => {
    const value = await fixture(evidence === "export-failure" ? { transfer: true, fail: "export" } : {});
    value.config.experiment.run.taskIds = ["a"];
    const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
    value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { solve: 0.15 } });
    value.components.solver.solve = async (_input, _session, context) => {
      if (evidence !== "missing-trajectory")
        await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1], context.key));
      if (evidence !== "missing-session")
        await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
      await untilAborted(context.signal);
      throw new Error("unreachable");
    };
    const result = await runEngine({ ...value, signal: new AbortController().signal });
    const record = result.records[0]!;
    expect(record).toMatchObject({ executionStatus: "agent_timeout", scoreStatus: "valid", cleanupStatus: "cleaned" });
    expect(computeSuccessRate(result)).toMatchObject({ denominator: 1, passed: 0, invalid: 0, rate: 0 });
    if (evidence === "partial") {
      expect(record.errors.map(error => error.code)).toEqual(["SOLVER_AGENT_TIMEOUT"]);
      expect(record.warnings).toEqual([expect.objectContaining({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE" })]);
      expect(record.collection.trajectory).toBe("partial");
      const report = renderMarkdown(result, {});
      expect(report).toContain("异常任务 1；错误记录 1（主流程 1；证据收集 0；资源清理 0）");
      expect(report).toContain("警告涉及 1 个任务，共 1 条记录");
      expect(report.split("## 错误分类与处理")[1]?.split("## 警告")[0]).not.toContain("ARTIFACT_COLLECTION_INCOMPLETE");
    } else {
      expect(record.errors).toContainEqual(expect.objectContaining({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE" }));
      expect(record.warnings ?? []).toEqual([]);
    }
    expect((await value.components.store.listAttempts())[0]?.record).toEqual(record);
  },
);

test("environment deadline is invalid immediately, even when task retries are enabled", async () => {
  const value = await fixture();
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 0.1;
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  let calls = 0;
  let drained = false;
  value.components.environment.prepare = async (...args) => {
    if (++calls === 1) {
      try { await untilAborted(args[3]); } finally { drained = true; }
    }
    return prepare(...args);
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(calls).toBe(1);
  expect(drained).toBe(true);
  const attempts = await value.components.store.listAttempts();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.record).toMatchObject({ executionStatus: "failed", });
  expect(result.records[0]?.executionStatus).toBe("failed");
});

test("exhausted verifier timeouts are invalid even with a successful solve; other tasks continue", async () => {
  const value = await fixture();
  value.config.experiment.run.onError = "continue";
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { verify: 0.03 } });
  const verify = value.components.benchmark.verify.bind(value.components.benchmark);
  let failures = 0;
  value.components.benchmark.verify = async (...args) => {
    if (args[0].input.id === "a") { failures++; await untilAborted(args[3]); }
    return verify(...args);
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(failures).toBe(1);
  expect(result.records[0]).toMatchObject({ executionStatus: "failed", verdict: null });
  expect(result.records[0]?.solve).not.toBeNull();
  expect(computeSuccessRate(result)).toMatchObject({ denominator: 2, invalid: 1, passed: 2, rate: 1 });
  expect((await harborScore.compute(result)).meanReward).toBe(1);
  expect(planResume(result.run, await value.components.store.listAttempts(), result.run.configFingerprint).restartTaskIds).toEqual(["a"]);
});

test("model service timeout is infrastructure, not an Agent deadline", async () => {
  const value = await fixture();
  value.config.experiment.run.taskIds = ["a"];
  let calls = 0;
  value.components.solver.solve = async () => { calls++; throw new DOMException("model service unavailable", "TimeoutError"); };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(calls).toBe(1);
  expect(result.records[0]).toMatchObject({ executionStatus: "failed", });
  expect(computeSuccessRate(result)).toMatchObject({ denominator: 0, invalid: 1, rate: null });
  expect((await harborScore.compute(result)).meanReward).toBeNull();
});

test("user cancellation stays cancelled and never launches another attempt", async () => {
  const value = await fixture();
  value.config.experiment.run.taskIds = ["a"];
  const controller = new AbortController();
  value.components.solver.solve = async () => { controller.abort(new Error("user cancelled")); throw controller.signal.reason; };
  const result = await runEngine({ ...value, signal: controller.signal });
  expect(result.run.status).toBe("cancelled");
  expect(result.records[0]?.executionStatus).toBe("cancelled");
  expect((result.records[0] ? attemptTimeoutKind(result.records[0]) : undefined)).toBeNull();
  expect(await value.components.store.listAttempts()).toHaveLength(1);
});

test("Ray infrastructure cancellation cannot be misclassified by an aborting harness's SOLVER_AGENT_TIMEOUT label", async () => {
  const value = await fixture();
  const controller = new AbortController();
  await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: ["a"] }, {});
  value.components.solver.solve = async () => {
    controller.abort(Object.assign(new Error("Ray coordinator heartbeat unavailable"), { code: "RAY_HEARTBEAT_TIMEOUT" }));
    throw Object.assign(new Error("harness stopped"), { code: "SOLVER_AGENT_TIMEOUT" });
  };
  const result = await runTask({ runId: storeRun.runId, taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" },
    configFingerprint: storeRun.configFingerprint }, value.components, source, controller.signal);
  expect(result).toMatchObject({ executionStatus: "failed", verdict: null });
  expect(computeSuccessRate(await value.components.store.snapshot())).toMatchObject({ denominator: 0, invalid: 1 });
});
