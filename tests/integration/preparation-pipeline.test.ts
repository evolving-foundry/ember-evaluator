import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { parseEffectiveConfig } from "../../src/config/effective.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { computeDuration } from "../../src/plugins/metrics/duration.js";
import { renderMarkdown } from "../../src/plugins/reporters/markdown.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { dshStream, interruptedResponse } from "../fixtures/engine/dsh-stream.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { HarborTaskError } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/compatibility.js";
import { assertDockerCapacity } from "../../src/infrastructure/containers/resources.js";
import { createTaskPreparer } from "../../src/core/preparation/materialize-task.js";
import type { PreparationRound } from "../../src/core/contracts/result.js";
import type { EnvironmentPreparationContext } from "../../src/core/contracts/environment.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(budget = 20) {
  const root = await mkdtemp(join(tmpdir(), "preparation-pipeline-"));
  const value = harness(root, { transfer: true });
  cleanups.push(async () => { await value.components.dispose(); await rm(root, { recursive: true, force: true }); });
  const { components, config } = value;
  config.experiment.run.preparation = { mode: "pipeline", concurrency: 2, lookahead: 2 };
  components.benchmark.planRun = (refs, source, signal) =>
    planBenchmarkRun(components.benchmark, refs, source, signal, { version: "test-v1", source: "test" }, budget);
  const prepareTask = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => {
    const task = await prepareTask(...args);
    task.solveEnv.image = args[0].id;
    if (task.verifyEnv) task.verifyEnv.image = `${args[0].id}:verify`;
    return task;
  };
  components.environment.materialize = async spec => ({ ...spec, preparationTiming: { imageMs: 2, runtimeMs: 1, solverMs: 0, cache: { image: "image" } } });
  const prepare = components.environment.prepare.bind(components.environment);
  components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    session.quiesce = async () => {};
    return session;
  };
  return value;
}

test.each(["batch", "pipeline"] as const)("%s allows cumulative preparation beyond the base and gives verify its own clock", async mode => {
  const { components, config, inputs } = await fixture(0.15);
  config.experiment.run.preparation = { mode, concurrency: 1 };
  components.environment.materialize = async (spec, signal) => {
    await delay(100, undefined, { signal });
    return spec;
  };
  const result = await runEngine({ components, config, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(inputs).toHaveLength(3);
  const round = result.run.preparationRounds?.[0];
  expect(round).toMatchObject({ budgetSeconds: null, deadlineAt: null, timeoutPolicy: "task-concurrency-v1" });
  expect(round?.tasks?.every(task => task.environmentTimeouts?.solve?.timeoutSeconds === 0.15 &&
    task.environmentTimeouts.verify?.timeoutSeconds === 0.15)).toBe(true);
  expect(computeDuration(result).preparation?.[0]?.environmentTimeouts).toHaveLength(6);
});

test("one task timing out while awaiting a shared installation does not cancel another waiter", async () => {
  const { components } = await fixture();
  const round = new AbortController();
  const gate = Promise.withResolvers<{ id: string; files: []; commands: []; probes: [] }>();
  const describe = vi.fn(async (signal: AbortSignal) => {
    expect(signal).toBe(round.signal);
    return gate.promise;
  });
  components.environment.supportsRuntimeInstallation = true;
  components.solver.runtimeInstallation = describe;
  const prepare = createTaskPreparer(components);
  const source = await components.benchmark.resolveSource(null, round.signal);
  const a = await components.benchmark.prepare({ id: "a", recordKey: "a" }, source, round.signal);
  const b = await components.benchmark.prepare({ id: "b", recordKey: "b" }, source, round.signal);
  a.preparationTimeoutSeconds = { solve: 0.02 };
  const context = { roundId: "shared", concurrency: 2, defaultTimeoutSeconds: 5, roundSignal: round.signal };
  const short = prepare(a, round.signal, context);
  const failure = expect(short).rejects.toMatchObject({ code: "ENV_PREPARATION_TIMEOUT" });
  const other = prepare(b, round.signal, context);
  try {
    await failure;
    expect(round.signal.aborted).toBe(false);
    gate.resolve({ id: "shared", files: [], commands: [], probes: [] });
    expect((await other).input.id).toBe("b");
    expect(describe).toHaveBeenCalledTimes(1);
  } finally { round.abort(); gate.resolve({ id: "shared", files: [], commands: [], probes: [] }); await other.catch(() => {}); }
});

test("concurrent preparation coalesces writes and persists readiness before publishing tasks", async () => {
  const { components } = await fixture();
  const signal = new AbortController().signal;
  const source = await components.benchmark.resolveSource(null, signal);
  const refs = Array.from({ length: 50 }, (_, index) => ({ id: `task-${index}`, recordKey: index }));
  const plan = await components.benchmark.planRun!(refs, source, signal);
  const contexts: (EnvironmentPreparationContext | undefined)[] = [];
  const materialize = components.environment.materialize!;
  components.environment.materialize = async (...args) => {
    contexts.push(args[4]);
    return materialize(...args);
  };
  let writes = 0;
  let saved: PreparationRound[] = [];
  components.store.updateRun = async update => {
    writes++;
    await new Promise<void>(resolve => setImmediate(resolve));
    if (update.preparationRounds) saved = structuredClone(update.preparationRounds);
  };
  const prepared = await components.scheduler.prepareTasks!([], plan, {
    previous: [], settings: { mode: "pipeline", concurrency: 20, lookahead: 50 }, sensitiveValues: [],
    store: components.store, prepareTask: createTaskPreparer(components),
  }, signal);
  const pipeline = prepared.pipeline!;
  const published: string[] = [];
  for await (const item of pipeline.tasks) {
    expect(saved[0]?.tasks?.find(task => task.taskId === item.task.input.id)?.status).toBe("ready");
    published.push(item.task.input.id);
  }
  await pipeline.completion;
  expect(published.sort()).toEqual(refs.map(ref => ref.id).sort());
  expect(contexts).toHaveLength(refs.length * 2);
  expect(contexts).toEqual(expect.arrayContaining(refs.flatMap(ref => [
    { taskId: ref.id, phase: "solve" }, { taskId: ref.id, phase: "verify" },
  ])));
  expect(saved[0]?.status).toBe("ready");
  expect(saved[0]?.tasks?.every(task => task.status === "ready")).toBe(true);
  expect(writes).toBeLessThan(50);
});

test("unsupported planning entries are recorded while other pipeline tasks run", async () => {
  const { components, config, inputs } = await fixture();
  config.experiment.run.onError = "continue";
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => {
    if (args[0].id === "b") throw new HarborTaskError("BENCHMARK_UNSUPPORTED", "GPU required");
    return prepare(...args);
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.taskIds).toEqual(["a", "b", "c"]);
  expect(inputs.map(input => input.id).sort()).toEqual(["a", "c"]);
  expect(snapshot.records.find(record => record.key.taskId === "b")).toMatchObject({ executionStatus: "failed", solve: null });
  expect(snapshot.records.filter(record => record.scoreStatus === "valid")).toHaveLength(2);
});

test("oversized task environments do not call the solver or block smaller tasks", async () => {
  const { components, config, inputs } = await fixture();
  config.experiment.run.onError = "continue";
  const materialize = components.environment.materialize!;
  components.environment.materialize = async (spec, signal, progress) => {
    assertDockerCapacity({ cpus: spec.image === "b" ? 8 : 1 }, { cpus: 4, memoryBytes: 8 * 1024 ** 3 });
    return materialize(spec, signal, progress);
  };
  const result = await runEngine({ components, config, signal: new AbortController().signal });
  expect(inputs.map(input => input.id).sort()).toEqual(["a", "c"]);
  expect(result.records.find(record => record.key.taskId === "b")).toMatchObject({
    scoreStatus: "invalid", solve: null, errors: [expect.objectContaining({ code: "ENV_RESOURCE_REQUIREMENTS_UNMET" })],
  });
});

test.each(["omitted", "duplicate", "foreign", "reordered"])("rejects %s run plans before dispatch", async kind => {
  const { components, config, inputs } = await fixture();
  const planRun = components.benchmark.planRun!;
  components.benchmark.planRun = async (...args) => {
    const plan = await planRun(...args);
    if (kind === "omitted") plan.tasks.pop();
    else if (kind === "duplicate") plan.tasks[1] = plan.tasks[0]!;
    else if (kind === "foreign") plan.tasks[0]!.input.id = "foreign";
    else plan.tasks.reverse();
    return plan;
  };
  await expect(runEngine({ components, config, signal: new AbortController().signal })).rejects.toThrow(/locked task selection/);
  expect(inputs).toHaveLength(0);
});

test("waiting for a slow solver does not consume the preparation clock", async () => {
  const { components, config } = await fixture(0.2);
  config.experiment.run.preparation = { mode: "pipeline", concurrency: 1, lookahead: 1, roundTimeoutSeconds: 0.2 };
  components.scheduler = new LocalScheduler(1);
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (...args) => { await new Promise(resolve => setTimeout(resolve, 250)); return solve(...args); };
  const result = await runEngine({ components, config, signal: new AbortController().signal });
  expect(result.records).toHaveLength(3);
  expect(result.records.every(record => record.scoreStatus === "valid")).toBe(true);
});

test.each(["pipeline", "batch"])("%s preparation timeout remains task-local and other tasks continue", async mode => {
  const { components, config, inputs } = await fixture(20);
  if (mode === "batch") config.experiment.run.preparation = { mode: "batch", concurrency: 1 };
  config.experiment.run.onError = "continue";
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => {
    const task = await prepare(...args);
    if (args[0].id === "a") task.preparationTimeoutSeconds = { solve: 0.04, verify: 0.04 };
    return task;
  };
  const materialize = components.environment.materialize!;
  components.environment.materialize = async (spec, signal, progress) => {
    if (spec.image === "a" || spec.image === "a:verify") {
      await delay(120, undefined, { signal });
      progress?.({ imageMs: 120, cache: "reference" });
      return { ...spec, preparationTiming: { imageMs: 120, runtimeMs: 1, solverMs: 0, cache: { image: "reference" } } };
    }
    return materialize(spec, signal, progress);
  };
  const result = await runEngine({ components, config, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(result.records.find(record => record.key.taskId === "a")).toMatchObject({ scoreStatus: "invalid",
    errors: [expect.objectContaining({ code: "ENV_PREPARATION_TIMEOUT" })] });
  expect(inputs.map(input => input.id).sort()).toEqual(["b", "c"]);
  const round = result.run.preparationRounds?.[0];
  expect(round?.budgetSeconds).toBeNull();
  const timing = round?.tasks?.find(task => task.taskId === "a");
  expect(timing?.environmentTimeouts?.solve).toMatchObject({ baseSeconds: 0.04, multiplier: mode === "batch" ? 1 : 2 });
  expect(timing?.status).toBe("error");
});

test.each(["solve", "verify"] as const)("pipeline preparation preserves the task's %s deadline and session cleanup", async phase => {
  const { components, config, events } = await fixture();
  config.experiment.run.taskIds = ["a"];
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args),
    preparationTimeoutSeconds: { solve: 20, verify: 20 }, phaseTimeoutSeconds: { [phase]: 0.05 } });
  if (phase === "solve") {
    const solve = components.solver.solve.bind(components.solver);
    components.solver.solve = async (...args) => {
      const result = await solve(...args);
      await untilAborted(args[2].signal);
      return result;
    };
  } else {
    components.benchmark.verify = async (_task, _result, _session, signal) => {
      await untilAborted(signal);
      throw new Error("unreachable");
    };
  }
  const result = await runEngine({ components, config, signal: new AbortController().signal });
  const record = result.records[0];
  expect(record?.errors).toContainEqual(expect.objectContaining({ phase,
    code: phase === "solve" ? "SOLVER_AGENT_TIMEOUT" : "VERIFY_TIMEOUT" }));
  expect(record?.executionStatus).toBe(phase === "solve" ? "agent_timeout" : "failed");
  expect(record?.cleanupStatus).toBe("cleaned");
  expect(events).toContain("solve.cleanup");
  if (phase === "verify") expect(events).toContain("verify.cleanup");
});
async function untilAborted(signal: AbortSignal) {
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test.each(["pipeline", "batch"])("%s reports numbered image progress before the full environment is ready", async mode => {
  const { components, config } = await fixture();
  if (mode === "batch") config.experiment.run.preparation = { mode: "batch", concurrency: 1 };
  const gate = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<void>();
  const events: ProgressEvent[] = [];
  components.environment.materialize = async (spec, _signal, onImageReady) => {
    onImageReady?.({ imageMs: 1200, cache: spec.image?.endsWith(":verify") ? "memory" : "built" });
    if (spec.image === "b") { reported.resolve(); await gate.promise; }
    return spec;
  };
  const running = runEngine({ components, config, signal: new AbortController().signal, onProgress: event => events.push(event) });
  try {
    await reported.promise;
    expect(events).toContainEqual(expect.objectContaining({
      phase: "prepare", taskId: "b", taskNumber: 2, taskTotal: 3,
      message: "Task image build completed; purpose=solve; elapsed 1.2s; source=new build",
    }));
    expect(events.some(event => event.taskId === "b" && event.message.startsWith("Environment ready"))).toBe(false);
  } finally { gate.resolve(); }
  expect((await running).run.status).toBe("completed");
  expect(events).toContainEqual(expect.objectContaining({ taskId: "b", taskNumber: 2, taskTotal: 3,
    message: "Task image ready; purpose=verify; elapsed 1.2s; source=in-process cache",
  }));
});

test.each(["explicit", "omitted", "empty", "mode-only", "concurrency-only", "lookahead-only"])("%s pipeline defaults let a ready task solve while an earlier environment is still preparing", async settings => {
  const { components, config, inputs } = await fixture();
  if (settings === "omitted") delete config.experiment.run.preparation;
  if (settings !== "omitted" && settings !== "explicit") {
    const preparation = settings === "mode-only" ? { mode: "pipeline" }
      : settings === "concurrency-only" ? { concurrency: 2 }
      : settings === "lookahead-only" ? { lookahead: 2 } : {};
    config.experiment.run = parseEffectiveConfig({ ...config.experiment, metrics: undefined,
      run: { ...config.experiment.run, preparation } }).run;
  }
  const gate = Promise.withResolvers<void>();
  let aReady = false;
  const materialize = components.environment.materialize;
  components.environment.materialize = async (spec, signal) => {
    if (spec.image === "a") { await gate.promise; aReady = true; }
    return materialize?.(spec, signal) ?? spec;
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(inputs.map(input => input.id)).toContain("b"));
    expect(aReady).toBe(false);
    const live = await components.store.snapshot();
    expect(live.run.preparationRounds?.[0]?.tasks?.find(task => task.taskId === "a")?.status).toBe("preparing");
  } finally { gate.resolve(); }
  const snapshot = await running;
  expect(snapshot.run.status).toBe("completed");
  expect(snapshot.records).toHaveLength(3);
  expect(snapshot.records.every(record => record.readiness && record.readiness.queueDurationMs >= 0)).toBe(true);
  const round = snapshot.run.preparationRounds?.[0];
  expect(round).toMatchObject({ mode: "pipeline", concurrency: 2,
    lookahead: settings === "explicit" || settings === "lookahead-only" ? 2 : 10, status: "ready" });
  expect(round?.tasks?.every(task => task.status === "ready" && task.durationMs !== null)).toBe(true);
  expect(computeDuration(snapshot).preparation?.[0]?.tasks?.count).toBe(3);
  expect(computeDuration(snapshot).readyQueue?.count).toBe(3);
  const markdown = renderMarkdown(snapshot, { duration: computeDuration(snapshot) });
  expect(markdown).toContain("环境准备耗时");
  expect(markdown).toContain("| 解题 |");
  expect(markdown).toContain("实际环境时限（秒）");
});

test.each([1, 3])("default preparation concurrency follows %s execution slots", async concurrency => {
  const { components, config } = await fixture();
  delete config.experiment.run.preparation;
  components.scheduler = new LocalScheduler(concurrency);
  config.experiment.scheduler.config.concurrency = concurrency;
  const gate = Promise.withResolvers<void>();
  const started: string[] = [];
  components.environment.materialize = async spec => {
    if (!spec.image?.endsWith(":verify")) { started.push(spec.image ?? "unknown"); await gate.promise; }
    return spec;
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(concurrency));
  } finally { gate.resolve(); }
  const snapshot = await running;
  expect(snapshot.run.status).toBe("completed");
  expect(snapshot.run.preparationRounds?.[0]).toMatchObject({ mode: "pipeline", concurrency });
});

test("independent preparation and execution limits bound work, including ready lookahead", async () => {
  const { components, config } = await fixture();
  components.scheduler = new LocalScheduler(1);
  components.benchmark.enumerate = async function* () {
    for (const id of ["a", "b", "c", "d", "e"]) yield { id, recordKey: id };
  };
  const gate = Promise.withResolvers<void>();
  const preparing: string[] = [];
  let live = 0, maxLive = 0, executing = 0, maxExecuting = 0;
  components.environment.materialize = async spec => {
    if (!spec.image?.endsWith(":verify")) preparing.push(spec.image ?? "unknown");
    live++; maxLive = Math.max(live, maxLive);
    await Promise.resolve(); live--;
    return spec;
  };
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (...args) => {
    executing++; maxExecuting = Math.max(executing, maxExecuting);
    await gate.promise;
    try { return await solve(...args); } finally { executing--; }
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  try {
    await vi.waitFor(() => expect(preparing).toHaveLength(3));
    await vi.waitFor(() => expect(executing).toBe(1));
    expect(preparing).not.toContain("d");
    expect(maxLive).toBeLessThanOrEqual(2);
  } finally { gate.resolve(); }
  expect((await running).records).toHaveLength(5);
  expect(maxExecuting).toBe(1);
});

test("continue records invalid preparation failures without retrying or fabricating scores", async () => {
  const { components, config } = await fixture();
  config.experiment.run.onError = "continue";
  components.environment.materialize = async spec => {
    if (spec.image === "a") throw new Error("bad recipe fixture-key");
    return spec;
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("error");
  expect(snapshot.pendingTaskIds).toEqual([]);
  expect(snapshot.records.map(record => record.key.taskId).sort()).toEqual(["a", "b", "c"]);
  expect(snapshot.records.find(record => record.key.taskId === "a")).toMatchObject({ executionStatus: "failed", solve: null, verdict: null });
  expect((await components.store.listAttempts()).filter(attempt => attempt.key.taskId === "a")).toHaveLength(1);
  expect(snapshot.run.preparationRounds?.[0]?.tasks?.find(task => task.taskId === "a")?.error).toContain("[redacted]");
  expect(JSON.stringify(snapshot)).not.toContain("fixture-key");
});

test("preparation abort cancels a live solver and drains both stages", async () => {
  const { components, config, entered } = await fixture();
  const fail = Promise.withResolvers<void>();
  let drained = false;
  components.environment.materialize = async (spec, signal) => {
    if (spec.image === "a") { await fail.promise; throw new Error("bad recipe"); }
    if (spec.image === "c") {
      try { await untilAborted(signal); } finally { drained = true; }
    }
    return spec;
  };
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (...args) => {
    const result = await solve(...args);
    await untilAborted(args[2].signal);
    return result;
  };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  const assertion = expect(running).rejects.toThrow("bad recipe");
  await entered.promise;
  await vi.waitFor(async () => expect((await components.store.snapshot()).run.preparationRounds?.[0]?.tasks?.find(task => task.taskId === "c")?.status).toBe("preparing"));
  fail.resolve();
  await assertion;
  expect(drained).toBe(true);
  const snapshot = await components.store.snapshot();
  expect(snapshot.run.status).toBe("error");
  expect(snapshot.records.find(record => record.key.taskId === "b")?.executionStatus).toBe("cancelled");
  expect(snapshot.records.find(record => record.key.taskId === "a")?.executionStatus).toBe("failed");
});

test.each(["solve", "verify"] as const)("environment deadlines drain blocked %s preparation and let running tasks finish", async phase => {
  const { components, config, entered } = await fixture(0.5);
  config.experiment.run.onError = "continue";
  const release = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const drained: string[] = [];
  components.environment.materialize = async (spec, signal) => {
    if (spec.image === (phase === "solve" ? "a" : "a:verify") ||
        spec.image === (phase === "solve" ? "c" : "c:verify")) {
      try { await untilAborted(signal); } finally { drained.push(spec.image); cancelled.resolve(); }
    }
    return spec;
  };
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (...args) => { await release.promise; return solve(...args); };
  const running = runEngine({ components, config, signal: new AbortController().signal });
  await vi.waitFor(async () => expect(await components.store.listAttempts()).toHaveLength(1));
  await cancelled.promise;
  release.resolve();
  await entered.promise;
  const snapshot = await running;
  expect(snapshot.records.find(record => record.key.taskId === "b")?.executionStatus).toBe("completed");
  expect(snapshot.run.status).toBe("error");
  expect(snapshot.run.preparationRounds?.[0]?.status).toBe("error");
  expect(snapshot.pendingTaskIds).toEqual([]);
  expect(snapshot.records.filter(record => record.executionStatus === "failed").map(record => record.key.taskId).sort()).toEqual(["a", "c"]);
  expect(drained.sort()).toEqual(phase === "solve" ? ["a", "c"] : ["a:verify", "c:verify"]);
  const timings = snapshot.run.preparationRounds?.[0]?.tasks;
  for (const id of ["a", "c"]) {
    const timing = timings?.find(task => task.taskId === id);
    expect(timing?.phaseDurationMs[phase === "solve" ? "solveEnvironment" : "verifyEnvironment"]).toBeGreaterThan(0);
    expect(timing?.finishedAt).not.toBeNull();
  }
});

test("external cancellation interrupts a pending readiness read and drains preparation", async () => {
  const { components, config } = await fixture();
  const entered = Promise.withResolvers<void>();
  let drained = 0;
  let started = 0;
  components.environment.materialize = async (_spec, signal) => {
    if (++started === 2) entered.resolve();
    try { await untilAborted(signal); } finally { drained++; }
    throw new Error("unreachable");
  };
  const controller = new AbortController();
  const running = runEngine({ components, config, signal: controller.signal });
  const settled = running.catch(error => error);
  await entered.promise;
  controller.abort(new Error("user cancelled"));
  await settled;
  expect(drained).toBe(2);
  const snapshot = await components.store.snapshot();
  expect(snapshot.run.status).toBe("cancelled");
  expect(snapshot.records).toHaveLength(0);
});

test("model truncation replans a pipeline task with a batch preparation barrier", async () => {
  const { components, config } = await fixture();
  const prepareTasks = vi.spyOn(components.scheduler, "prepareTasks");
  config.experiment.run.taskIds = ["a"];
  config.experiment.run.timeoutSeconds = 2;
  let prepared = 0, calls = 0;
  components.environment.materialize = async spec => {
    prepared++;
    await new Promise(resolve => setTimeout(resolve, 1100));
    return spec;
  };
  components.solver.solve = async (_input, _session, context) =>
    consumeDsh(dshStream(++calls === 1 ? interruptedResponse : undefined), context, "fixture-key");
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("completed");
  expect(prepared).toBe(4);
  expect(calls).toBe(2);
  expect(await components.store.listAttempts()).toHaveLength(2);
  expect(prepareTasks.mock.calls.map(call => call[2].settings?.mode)).toEqual(["pipeline", "batch"]);
}, 15_000);

test("pipeline rejects unsupported distributed scheduling explicitly", async () => {
  const { components, config } = await fixture();
  class RemoteScheduler extends LocalScheduler { readonly executionLocation = "remote"; }
  components.scheduler = new RemoteScheduler(2);
  await expect(runEngine({ components, config, signal: new AbortController().signal })).rejects.toThrow("Pipeline preparation requires");
});


test("attempt fail-fast stops ready dispatch before refilling its execution slot", async () => {
  const { components, config } = await fixture();
  components.scheduler = new LocalScheduler(1);
  config.experiment.run.preparation = { mode: "pipeline", concurrency: 1, lookahead: 2 };
  const started: string[] = [];
  components.solver.solve = async input => { started.push(input.id); throw new Error("deterministic solver failure"); };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("error");
  expect(started).toEqual(["a"]);
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]?.executionStatus).toBe("failed");
  expect(snapshot.pendingTaskIds).toEqual(["b", "c"]);
});

test("resume prepares only pending tasks and preserves the previous timing round", async () => {
  const { components, config } = await fixture();
  config.experiment.run.onError = "continue";
  const materialize = components.environment.materialize;
  components.environment.materialize = async (spec, signal) => {
    if (spec.image === "a") throw new Error("temporary build failure");
    return materialize?.(spec, signal) ?? spec;
  };
  const first = await runEngine({ components, config, signal: new AbortController().signal });
  await components.store.close();
  const prepared: (string | null)[] = [];
  components.environment.materialize = async (spec, signal) => {
    prepared.push(spec.image);
    return materialize?.(spec, signal) ?? spec;
  };
  const second = await runEngine({ components, config, signal: new AbortController().signal,
    resumeDirectory: join(config.experiment.output.directory, first.run.runId) });
  expect(second.run.status).toBe("completed");
  expect(prepared).toEqual(["a", "a:verify"]);
  expect(second.run.preparationRounds?.[0]).toEqual(first.run.preparationRounds?.[0]);
  expect(second.run.preparationRounds).toHaveLength(2);
  expect(second.records).toHaveLength(3);
});


test("a network preparation failure stays terminal while continue mode executes other tasks", async () => {
  const { components, config } = await fixture();
  config.experiment.run.onError = "continue";
  let first = true;
  const materialize = components.environment.materialize!;
  components.environment.materialize = async (...args) => {
    if (args[0].image === "a" && first) { first = false; throw Object.assign(new Error("registry reset"), { code: "NETWORK_FAILURE", details: { networkStage: "docker-pull", networkEvidence: "ECONNRESET", networkReason: "connection-interrupted" } }); }
    return materialize(...args);
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("error"); expect(snapshot.attemptHistory).toHaveLength(3);
  expect(snapshot.run.preparationRounds).toHaveLength(1);
  expect(renderMarkdown(snapshot, {})).toContain("NETWORK_FAILURE");
  expect(computeDuration(snapshot).preparation?.every(round => round.status === "ready")).toBe(false);
});
