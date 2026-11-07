import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { parseEffectiveConfig } from "../../src/config/effective.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { dshStream, interruptedResponse } from "../fixtures/engine/dsh-stream.js";
import type { EnvironmentPreparationContext } from "../../src/core/contracts/environment.js";
import type { ScheduledPreparation } from "../../src/core/contracts/preparation.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test("20 live attempts refill only after verification and persistence, without waiting for their peers", async () => {
  const { components, config } = await fixture();
  components.scheduler = new LocalScheduler(20);
  components.benchmark.enumerate = async function* () {
    for (let index = 0; index < 22; index++) yield { id: `t${index}`, recordKey: index };
  };
  const gates = Array.from({ length: 22 }, () => Promise.withResolvers<void>());
  const verifying = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<void>();
  const committing = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const started: string[] = [];
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (input, session, context) => {
    started.push(input.id);
    await gates[Number(input.id.slice(1))]!.promise;
    return solve(input, session, context);
  };
  const verify = components.benchmark.verify.bind(components.benchmark);
  components.benchmark.verify = async (...args) => {
    if (args[0].input.id === "t7") { verifying.resolve(); await verified.promise; }
    return verify(...args);
  };
  const commit = components.store.commit.bind(components.store);
  components.store.commit = async (...args) => {
    if (args[0].key.taskId === "t7") { committing.resolve(); await committed.promise; }
    return commit(...args);
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(20), { timeout: 10_000 });
    gates[7]!.resolve();
    await verifying.promise;
    expect(started).toHaveLength(20);
    verified.resolve();
    await committing.promise;
    expect(started).toHaveLength(20);
    committed.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(21), { timeout: 5_000 });
    expect(started.at(-1)).toBe("t20");
    gates[3]!.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(22), { timeout: 5_000 });
    expect(started.at(-1)).toBe("t21");
  } finally {
    verified.resolve(); committed.resolve();
    for (const gate of gates) gate.resolve();
    const snapshot = await running;
    expect(snapshot.records).toHaveLength(22);
    expect(snapshot.records.every(record => record.executionStatus === "completed")).toBe(true);
  }
}, 30_000);

async function fixture(budget = 10) {
  const root = await mkdtemp(join(tmpdir(), "batch-preparation-"));
  const value = harness(root, { transfer: true });
  cleanups.push(async () => { await value.dispose(); await rm(root, { recursive: true, force: true }); });
  const { components, config, events } = value;
  config.experiment.run.preparation = { mode: "batch", concurrency: 1 };
  components.benchmark.planRun = (refs, source, signal) =>
    planBenchmarkRun(components.benchmark, refs, source, signal, { version: "test-v1", source: "test" }, budget);
  components.environment.materialize = async spec => { events.push("materialize"); return spec; };
  const prepare = components.environment.prepare;
  components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    session.quiesce = async () => { events.push(`${args[2]}.quiesce`); };
    return session;
  };
  return value;
}

test("all solve and verify environments become ready before any attempt starts", async () => {
  const { components, config, events } = await fixture();
  const gate = Promise.withResolvers<void>();
  let count = 0;
  const contexts: (EnvironmentPreparationContext | undefined)[] = [];
  components.environment.materialize = async (spec, _signal, _ready, _activity, context) => {
    contexts.push(context);
    events.push("materialize");
    if (++count === 6) await gate.promise;
    return spec;
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  await vi.waitFor(() => expect(count).toBe(6));
  expect(events).not.toContain("solve.environment");
  expect(await components.store.listAttempts()).toHaveLength(0);
  gate.resolve();
  const snapshot = await running;
  expect(snapshot.records).toHaveLength(3);
  expect(snapshot.run.preparationRounds).toHaveLength(1);
  expect(snapshot.run.preparationRounds?.[0]?.status).toBe("ready");
  expect(contexts).toEqual(["a", "b", "c"].flatMap(taskId => [
    { taskId, phase: "solve" }, { taskId, phase: "verify" },
  ]));
  expect(events.indexOf("solve.quiesce")).toBeLessThan(events.indexOf("export"));
  expect(events.indexOf("solve.cleanup")).toBeLessThan(events.indexOf("verify.environment"));
});

test("a batch scheduler that omits a task cannot dispatch it with unprepared dependencies", async () => {
  const { components, config, inputs } = await fixture();
  const prepare = components.scheduler.prepareTasks!.bind(components.scheduler);
  components.scheduler.prepareTasks = async (...args) => {
    const scheduled = await prepare(...args);
    if (scheduled.pipeline) throw new Error("Expected a batch");
    return { tasks: scheduled.tasks.slice(1) };
  };
  await expect(runEngine({ components, config, signal: new AbortController().signal }))
    .rejects.toThrow("Batch preparation differs from locked task plan");
  expect(inputs).toHaveLength(0);
  expect(await components.store.listAttempts()).toHaveLength(0);
});

test("model truncation prepares another round only for the failed task", async () => {
  const { components, config, events } = await fixture();
  components.scheduler = new LocalScheduler(1);
  config.experiment.run.onError = "continue";
  const calls = new Map<string, number>();
  components.solver.solve = async (input, _session, context) => {
    const count = (calls.get(input.id) ?? 0) + 1;
    calls.set(input.id, count);
    return consumeDsh(dshStream(input.id === "a" && count === 1 ? interruptedResponse : undefined),
      context, "fixture-key");
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("completed");
  expect([...calls.entries()]).toEqual([["a", 2], ["b", 1], ["c", 1]]);
  expect(events.filter(event => event === "materialize")).toHaveLength(8);
  expect(snapshot.run.preparationRounds).toHaveLength(2);
  expect(await components.store.listAttempts()).toHaveLength(4);
});

test.each([undefined, 1, 2])("batch preparation concurrency %s preserves the barrier and plan order", async concurrency => {
  const { components, config, inputs } = await fixture();
  config.experiment.run = parseEffectiveConfig({ ...config.experiment, metrics: undefined,
    run: { ...config.experiment.run, preparation: { mode: "batch", ...(concurrency === undefined ? {} : { concurrency }) } } }).run;
  const gates = new Map(["a", "b", "c"].map(id => [id, Promise.withResolvers<void>()]));
  const started: string[] = [];
  let active = 0, maximum = 0;
  components.environment.materialize = async (spec, _signal, _ready, _activity, context) => {
    if (context?.phase === "solve") {
      started.push(context.taskId);
      maximum = Math.max(maximum, ++active);
      try { await gates.get(context.taskId)!.promise; } finally { active--; }
    }
    return spec;
  };
  const prepareTasks = vi.spyOn(components.scheduler, "prepareTasks");
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(concurrency ?? 2));
    expect(await components.store.listAttempts()).toHaveLength(0);
    if (concurrency !== 1) {
      gates.get("b")!.resolve();
      await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
      gates.get("c")!.resolve();
      expect(inputs).toHaveLength(0);
      expect(await components.store.listAttempts()).toHaveLength(0);
    } else {
      gates.get("a")!.resolve();
      await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
      gates.get("b")!.resolve();
      await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
      expect(inputs).toHaveLength(0);
    }
  } finally { for (const gate of gates.values()) gate.resolve(); }
  const snapshot = await running;
  expect(snapshot.run.status).toBe("completed");
  expect(maximum).toBe(concurrency ?? 2);
  const prepared: ScheduledPreparation = await prepareTasks.mock.results[0]?.value;
  expect(prepared?.tasks?.map(task => task.input.id)).toEqual(["a", "b", "c"]);
  expect(snapshot.run.preparationRounds?.[0]?.concurrency ?? 1).toBe(concurrency ?? 2);
});

test.each(["cancel", "deadline"] as const)("concurrent batch %s drains workers and leaves queued preparation unstarted", async mode => {
  const { components, config } = await fixture();
  config.experiment.run.preparation = { mode: "batch", concurrency: 2, ...(mode === "deadline" ? { roundTimeoutSeconds: 0.3 } : {}) };
  const controller = new AbortController();
  const cleanup = Promise.withResolvers<void>();
  const started: string[] = [];
  let cancelled = 0, drained = 0, settled = false;
  components.environment.materialize = async (_spec, signal, _ready, _activity, context) => {
    started.push(context!.taskId);
    try {
      return await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } finally { cancelled++; await cleanup.promise; drained++; }
  };
  const running = runEngine({ components, config, signal: controller.signal }).catch(error => error).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    if (mode === "cancel") controller.abort(new Error("controlled batch cancellation"));
    await vi.waitFor(() => expect(cancelled).toBe(2));
    expect(settled).toBe(false);
    expect(await components.store.listAttempts()).toHaveLength(0);
  } finally { cleanup.resolve(); await running; }
  expect(drained).toBe(2);
  expect(started).toEqual(["a", "b"]);
  const snapshot = await components.store.snapshot();
  expect(snapshot.run.status).toBe(mode === "cancel" ? "cancelled" : "error");
  expect(snapshot.run.preparationRounds?.[0]?.tasks).toEqual([
    expect.objectContaining({ taskId: "a", status: "cancelled" }),
    expect.objectContaining({ taskId: "b", status: "cancelled" }),
    expect.objectContaining({ taskId: "c", status: "cancelled", startedAt: null }),
  ]);
});

test("one failed concurrent batch task preserves successful preparations", async () => {
  const { components, config, inputs } = await fixture();
  config.experiment.run.preparation = { mode: "batch", concurrency: 2 };
  config.experiment.run.onError = "continue";
  components.environment.materialize = async (spec, _signal, _ready, _activity, context) => {
    if (context?.taskId === "b") throw new Error("controlled task preparation failure");
    return spec;
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(inputs.map(input => input.id).sort()).toEqual(["a", "c"]);
  expect(snapshot.records.find(record => record.key.taskId === "b")).toMatchObject({ executionStatus: "failed", solve: null });
  expect(snapshot.run.preparationRounds?.[0]?.tasks?.map(task => task.status)).toEqual(["ready", "error", "ready"]);
});

test("batch deadline records started failures and leaves queued preparations pending without solving", async () => {
  const { components, config, events } = await fixture();
  config.experiment.run.preparation = { mode: "batch", concurrency: 1, roundTimeoutSeconds: 0.08 };
  config.experiment.run.onError = "continue";
  components.environment.materialize = async (_spec, signal) => {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable");
  };
  await runEngine({ components, config, signal: new AbortController().signal });
  const snapshot = await components.store.snapshot();
  expect(snapshot.run.status).toBe("error");
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]).toMatchObject({ key: { taskId: "a" }, executionStatus: "failed",
    errors: [expect.objectContaining({ code: "ENV_PREPARATION_TIMEOUT" })] });
  expect(snapshot.pendingTaskIds).toEqual(["b", "c"]);
  expect(snapshot.run.preparationRounds).toHaveLength(1);
  expect(snapshot.run.preparationRounds?.[0]).toMatchObject({ budgetSeconds: 0.08, status: "error", failure: { code: "ENV_PREPARATION_TIMEOUT" } });
  expect(events).not.toContain("solve.environment");
});

test("a task preparation deadline stops an aborting batch without assigning its timeout to queued tasks", async () => {
  const { components, config, events } = await fixture(0.05);
  components.environment.materialize = async (_spec, signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]).toMatchObject({ key: { taskId: "a" }, errors: [expect.objectContaining({ code: "ENV_PREPARATION_TIMEOUT" })] });
  expect(snapshot.pendingTaskIds).toEqual(["b", "c"]);
  expect(snapshot.run.preparationRounds?.[0]?.tasks?.map(task => task.status)).toEqual(["error", "cancelled", "cancelled"]);
  expect(events).not.toContain("solve.environment");
});

test("a required environment failure aborts the batch without scores", async () => {
  const { components, config } = await fixture();
  config.experiment.run.onError = "continue";
  components.environment.materialize = async () => { throw new Error("build unavailable"); };
  await runEngine({ components, config, signal: new AbortController().signal });
  const snapshot = await components.store.snapshot();
  expect(snapshot.records).toHaveLength(3);
  expect(snapshot.records.every(record => record.executionStatus === "failed" && record.verdict === null)).toBe(true);
  expect(snapshot.pendingTaskIds).toEqual([]);
  expect(snapshot.run.preparationRounds?.[0]?.tasks?.every(task => task.failure?.message.includes("build unavailable"))).toBe(true);
});

test("resuming a failed preparation retains history and opens a new round", async () => {
  const { components, config } = await fixture();
  components.environment.materialize = async () => { throw new Error("first preparation failed"); };
  await runEngine({ components, config, signal: new AbortController().signal });
  const first = await components.store.snapshot();
  await components.store.close();
  components.environment.materialize = async spec => spec;
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal,
    resumeDirectory: join(config.experiment.output.directory, first.run.runId) });
  expect(snapshot.run.preparationRounds?.map(round => round.status)).toEqual(["error", "ready"]);
  expect(snapshot.records).toHaveLength(3);
});
