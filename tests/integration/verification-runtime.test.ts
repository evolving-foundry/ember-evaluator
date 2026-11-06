import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun } from "../fixtures/results/store-fixture.js";
import { runEngine } from "../../src/application/run-engine.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import type { VerificationRuntime, VerificationRuntimeSession } from "../../src/core/contracts/verification-runtime.js";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { createTaskPreparer } from "../../src/core/preparation/materialize-task.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const job = { runId: "run-1", taskId: "a", attemptId: "attempt-1", ref: { id: "a", recordKey: "a" }, configFingerprint: "config-hash" };
async function fixture(mode: "direct" | "batch" | "pipeline" = "direct") {
  const root = await mkdtemp(join(tmpdir(), "verification-runtime-"));
  const value = harness(root);
  const { components, config, events } = value;
  cleanup.push(async () => { await components.dispose(); await rm(root, { recursive: true, force: true }); });
  config.experiment.run.taskIds = ["a"];
  config.experiment.run.onError = "continue";
  const handle: VerificationRuntimeSession = {
    metadata: { image: "private-image" },
    async verify(result, environment) {
      events.push("runtime.verify");
      expect(result.finalText).toBe("Answer: 42"); expect(environment).toBeNull();
      return { passed: true, score: 1, details: { runtime: true } };
    },
    async dispose(signal) { signal.throwIfAborted(); events.push("runtime.cleanup"); },
  };
  const runtime: VerificationRuntime = {
    async materialize() { events.push("runtime.materialize"); return { image: "private-image" }; },
    async prepare(task, receipt) {
      expect(task.verification).toEqual({ expected: "private-solution" });
      expect(receipt).toEqual({ image: "private-image" }); events.push("runtime.prepare"); return handle;
    },
  };
  components.benchmark = { ...components.benchmark, verificationRuntime: runtime };
  if (mode !== "direct") {
    components.benchmark.planRun = (refs, locked, signal, activity) =>
      planBenchmarkRun(components.benchmark, refs, locked, signal, { version: "fixture", source: "fixture" }, 5, activity);
    components.environment.materialize = async spec => spec;
    const prepare = components.environment.prepare.bind(components.environment);
    components.environment.prepare = async (...args) => ({ ...await prepare(...args), async quiesce() {} });
    config.experiment.run.preparation = { mode, concurrency: 1, ...(mode === "pipeline" ? { lookahead: 1 } : {}) };
  }
  return { root, ...value, runtime, handle };
}

test.each(["direct", "batch", "pipeline"] as const)("%s waits for verifier dependencies before solving and keeps the receipt private", async mode => {
  const { components, config, runtime, events, inputs } = await fixture(mode);
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>();
  runtime.materialize = async () => { events.push("runtime.materialize"); entered.resolve(); await ready.promise; return { image: "private-image" }; };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try { await entered.promise; expect(inputs).toHaveLength(0); expect(events).not.toContain("runtime.prepare"); }
  finally { ready.resolve(); }
  const snapshot = await running;
  expect(snapshot.records[0]).toMatchObject({ executionStatus: "completed", cleanupStatus: "cleaned",
    environments: { verificationRuntime: { image: "private-image" } }, verdict: { score: 1 } });
  expect(events.filter(event => event.startsWith("runtime."))).toEqual(["runtime.materialize", "runtime.prepare", "runtime.verify", "runtime.cleanup"]);
  expect(events).not.toContain("verify");
  expect(JSON.stringify(inputs)).not.toMatch(/private-image|private-solution|verificationRuntime/);
});

test.each(["batch", "pipeline", "worker"] as const)("%s prepares solver, solve, verify and private dependencies in order", async mode => {
  const { components, config, runtime, handle } = await fixture(mode === "worker" ? "batch" : mode);
  handle.verify = async () => ({ score: 1, passed: true, details: {} });
  config.experiment.run.taskIds = ["a", "b", "c"];
  const calls: string[] = [];
  const installation = { id: "solver-runtime", files: [], commands: [], probes: [] };
  components.solver.runtimeInstallation = vi.fn(async () => installation);
  components.environment.supportsRuntimeInstallation = true;
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args),
    verifyEnv: { workdir: ".", image: null, runtime: [], initialFiles: [] },
    transfer: { kind: "workspace-archive", workdir: ".", extraPaths: [] },
  });
  components.environment.materialize = async (spec, _signal, _progress, _activity, context) => {
    calls.push(`${context?.taskId}:${context?.phase}`);
    if (context?.phase === "solve") {
      expect(spec.installation).toEqual(installation);
      expect(spec.runtime).toEqual(components.solver.requirements());
    } else {
      expect(spec.installation).toBeUndefined();
      expect(spec.runtime).toEqual([]);
    }
    return { ...spec, preparationTiming: { imageMs: 1, runtimeMs: 2, solverMs: 3 } } satisfies EnvironmentSpec;
  };
  runtime.materialize = async task => { calls.push(`${task.input.id}:private`); return { image: "private-image" }; };
  if (mode === "worker") {
    const signal = new AbortController().signal;
    const materialize = createTaskPreparer(components);
    const tasks = await Promise.all(["a", "b", "c"].map(async id => {
      const task = await components.benchmark.prepare({ id, recordKey: id }, source, signal);
      return materialize(task, signal, { roundId: "worker-round", attemptId: id, concurrency: 3, defaultTimeoutSeconds: 5, roundSignal: signal });
    }));
    expect(tasks.every(task => task.verificationRuntime !== undefined)).toBe(true);
  } else {
    const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.run.preparationRounds?.[0]?.tasks?.every(task => task.status === "ready")).toBe(true);
  }
  expect(components.solver.runtimeInstallation).toHaveBeenCalledTimes(1);
  for (const id of ["a", "b", "c"]) expect(calls.filter(call => call.startsWith(`${id}:`))).toEqual([`${id}:solve`, `${id}:verify`, `${id}:private`]);
});

test.each(["direct", "batch", "pipeline"] as const)("%s preparation failure prevents model work", async mode => {
  const { components, config, runtime, inputs, events } = await fixture(mode);
  runtime.materialize = async () => { throw new Error("verifier dependency unavailable"); };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(inputs).toHaveLength(0); expect(events).not.toContain("runtime.prepare");
  expect(snapshot.records[0]?.errors.some(error => error.message.includes("verifier dependency unavailable"))).toBe(true);
  expect(snapshot.records[0]?.scoreStatus).toBe("invalid");
});

test.each(["verify-error", "cancel", "cleanup-error"] as const)("verifier lifecycle records %s and attempts all cleanup", async mode => {
  const { components, config, handle, events } = await fixture();
  const cancel = new AbortController();
  if (mode === "verify-error") handle.verify = async () => { throw new Error("verifier failed"); };
  if (mode === "cancel") handle.verify = async () => { cancel.abort(new Error("cancelled during verification")); throw cancel.signal.reason; };
  if (mode === "cleanup-error") handle.dispose = async signal => { signal.throwIfAborted(); events.push("runtime.cleanup"); throw new Error("cannot remove verifier container"); };
  const snapshot = await runEngine({ components, config, signal: cancel.signal });
  expect(events).toContain("runtime.cleanup"); expect(events).toContain("solve.cleanup");
  expect(snapshot.records[0]?.errors.some(error => error.phase === (mode === "cleanup-error" ? "cleanup" : "verify"))).toBe(true);
  if (mode === "cleanup-error") expect(snapshot.records[0]).toMatchObject({ scoreStatus: "valid", cleanupStatus: "unconfirmed", verdict: { score: 1 } });
});

test("a verifier handle returned after cancellation and cleanup deadline is still disposed", async () => {
  const { components, root, runtime, handle } = await fixture();
  await components.store.create(join(root, "runs"), { ...storeRun, source, taskIds: ["a"] }, {});
  const cancel = new AbortController(), released = Promise.withResolvers<void>(), disposed = Promise.withResolvers<void>();
  runtime.prepare = async () => { cancel.abort(new Error("cancel while opening verifier")); await released.promise; return handle; };
  handle.dispose = async signal => { signal.throwIfAborted(); disposed.resolve(); };
  const record = await runTask(job, components, source, cancel.signal, { cleanupTimeoutMs: 20 });
  expect(record.cleanupStatus).toBe("unconfirmed");
  expect(record.environments.verificationRuntime).toBeUndefined();
  released.resolve(); await disposed.promise;
  expect(record.environments.verificationRuntime).toBeUndefined();
});

test("ready tasks missing verifier receipts fail without rerunning preparation or the model", async () => {
  const { components, root, runtime, inputs } = await fixture();
  await components.store.create(join(root, "runs"), { ...storeRun, source, taskIds: ["a"] }, {});
  const task = await components.benchmark.prepare(job.ref, source, new AbortController().signal);
  const materialize = vi.spyOn(runtime, "materialize");
  const record = await runTask(job, components, source, new AbortController().signal, { preparedTask: task });
  expect(record.errors[0]?.message).toContain("verification runtime receipt");
  expect(materialize).not.toHaveBeenCalled(); expect(inputs).toHaveLength(0);
});

test("resume recovers verifier resources without repeating a valid score", async () => {
  const { components, config, runtime, handle, inputs } = await fixture();
  handle.dispose = async () => { throw new Error("unconfirmed verifier removal"); };
  const first = await runEngine({ components, config, signal: new AbortController().signal });
  components.environment.recoverAttempts = async () => {};
  runtime.recoverAttempts = vi.fn(async () => {});
  await components.store.close();
  const resumed = await runEngine({ components, config, signal: new AbortController().signal,
    resumeDirectory: join(config.experiment.output.directory, first.run.runId) });
  expect(runtime.recoverAttempts).toHaveBeenCalledWith([first.records[0]!.key], expect.any(AbortSignal));
  expect(inputs).toHaveLength(1); expect(resumed.records).toEqual(first.records);
});
