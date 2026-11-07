import { attemptTimeoutKind } from "../../src/core/results/evaluation-outcome.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifactReadFailure = vi.hoisted(() => ({ suffix: null as string | null, failOnCall: 0, calls: 0, removeOnFailure: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream(path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) {
      const normalized = String(path).replaceAll("\\", "/");
      if (artifactReadFailure.suffix && normalized.endsWith(artifactReadFailure.suffix)) {
        artifactReadFailure.calls++;
        if (artifactReadFailure.failOnCall === 0 || artifactReadFailure.calls === artifactReadFailure.failOnCall) {
          if (artifactReadFailure.removeOnFailure) actual.unlinkSync(path);
          throw Object.assign(new Error("injected evidence read failure"), { code: "EIO" });
        }
      }
      return actual.createReadStream(path, options);
    },
  };
});
import { harness, source } from "../fixtures/engine/fakes.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { runEngine } from "../../src/application/run-engine.js";
import { storeRun } from "../fixtures/results/store-fixture.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { VerificationError } from "../../src/index.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { QualityScoreMetrics } from "../../src/plugins/metrics/quality-score.js";
import { HarborScoreMetrics } from "../../src/plugins/metrics/harbor-score.js";
import { SuccessRateMetrics } from "../../src/plugins/metrics/success-rate.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";
import { scoreHarborEvidence } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/verify.js";
import { saveReport } from "../../src/application/report/index.js";

const resources: { root: string; value: ReturnType<typeof harness> }[] = [];
async function fixture(options: Parameters<typeof harness>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-engine-")); const value = harness(root, options);
  resources.push({ root, value }); return { root, ...value };
}
afterEach(async () => {
  vi.restoreAllMocks();
  artifactReadFailure.suffix = null; artifactReadFailure.failOnCall = 0; artifactReadFailure.calls = 0; artifactReadFailure.removeOnFailure = false;
  for (const { root, value } of resources.splice(0)) { await value.dispose(); await rm(root, { recursive: true, force: true }); }
});
const job = { runId: "run-1", taskId: "a", attemptId: "attempt-1", ref: { id: "a", recordKey: "a" }, configFingerprint: "config-hash" };
async function taskFixture(options: Parameters<typeof harness>[1] = {}) {
  const result = await fixture(options);
  await result.components.store.create(join(result.root, "runs"), { ...storeRun, source, taskIds: ["a"] }, {});
  return result;
}

test("includeTaskAnswer stores the prompt and only a textual answer", async () => {
  const { components } = await taskFixture();
  components.benchmark.discloseAnswer = () => "private-solution";
  const disclosed = await runTask(job, components, source, new AbortController().signal, { includeTaskAnswer: true });
  expect(disclosed.task).toEqual({ prompt: "Public question", answer: "private-solution" });
  expect(JSON.stringify(disclosed.task)).not.toContain("hidden");
});

test("a scheduler without the required stream interface is rejected before creating a run", async () => {
  const { components, config } = await fixture();
  const create = vi.spyOn(components.store, "create");
  Reflect.set(components.scheduler, "executeReady", undefined);
  await expect(runEngine({ components, config, signal: new AbortController().signal })).rejects.toThrow(/executeReady/);
  expect(create).not.toHaveBeenCalled();
});

test("an unregistered plugin warning becomes a protocol failure without exposing its code", async () => {
  const { components } = await taskFixture();
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (input, session, context) => {
    if (context.warning) Reflect.apply(context.warning, undefined, [{ code: "PRIVATE_LEGACY_CODE", message: "warning" }]);
    return solve(input, session, context);
  };
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "SOLVER_PROTOCOL_INVALID" }));
  expect(JSON.stringify(result)).not.toContain("PRIVATE_LEGACY_CODE");
});

test("Solver warnings preserve valid zero scores and do not interrupt verification", async () => {
  const { components } = await taskFixture();
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (input, session, context) => {
    context.warning?.({ code: "SOLVER_OUTPUT_LIMIT", message: "finish_reason=length fixture-key" });
    const result = await solve(input, session, context);
    return { ...result, finalText: "" };
  };
  const verify = vi.fn(async () => ({ score: 0, passed: false, details: { evaluated: true } }));
  components.benchmark.verify = verify;
  const progress: unknown[] = [];
  const result = await runTask(job, components, source, new AbortController().signal,
    { sensitiveValues: ["fixture-key"], onProgress: event => progress.push(event) });
  expect(verify).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", solve: { finalText: "" }, verdict: { score: 0 }, errors: [] });
  expect(result.warnings).toEqual([{ phase: "solve", code: "SOLVER_OUTPUT_LIMIT", message: "finish_reason=length [redacted]" }]);
  expect(progress).toContainEqual(expect.objectContaining({ warning: true, phase: "solve" }));
  expect(JSON.stringify(progress)).not.toContain("fixture-key");
});

test("DSH max-tokens exit 1 reaches benchmark verification with its partial output and artifacts", async () => {
  const { components } = await taskFixture();
  let artifact = "";
  components.solver.solve = async (_input, _session, context) => {
    artifact = join(context.paths.agent, "partial.txt");
    await writeFile(artifact, "saved work");
    const records = [
      { type: "session", sessionId: "truncated", cwd: "/workspace" },
      { type: "status", phase: "turn_start", turn: 1 },
      { type: "status", phase: "step_start", turn: 1, step: 1 },
      { type: "status", phase: "step_end", turn: 1, step: 1 },
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "max-tokens" } },
      { type: "final", text: "Partial answer" },
    ];
    return consumeDsh({ stdout: (async function* () { yield Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n"); })(),
      stderr: (async function* () {})(), done: Promise.resolve({ code: 1, signal: null }), async stop() {} }, context, "");
  };
  const verify = vi.fn<typeof components.benchmark.verify>(async (_task, solve) => {
    expect(solve.finalText).toBe("Partial answer");
    expect(await readFile(artifact, "utf8")).toBe("saved work");
    return { score: 0.25, passed: false, details: { evaluated: true } };
  });
  components.benchmark.verify = verify;
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.errors).toEqual([]);
  expect(verify).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 0.25 }, errors: [],
    warnings: [expect.objectContaining({ code: "SOLVER_OUTPUT_LIMIT" })] });
});

test.each([0, 127, 126])("collect logs retain diagnostics and only successful hooks reach verification: %s", async code => {
  const { components, root } = await taskFixture({ transfer: true });
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args),
    collect: [{ service: "redis", executable: "sh", args: ["-c", "capture"], cwd: "/", env: {}, timeoutSeconds: 5 }] });
  const environment = components.environment.prepare.bind(components.environment);
  components.environment.prepare = async (...args) => {
    const session = await environment(...args);
    session.transitionToVerification = async () => {};
    session.startService = async () => ({ stdout: (async function* () { yield Buffer.from(code === 126 ? "bash: not found; fixture-key\n" : "capturing\n"); })(),
      stderr: (async function* () { if (code === 127) yield Buffer.from("bash: not found; fixture-key\n"); })(),
      done: Promise.resolve({ code, signal: null }), async stop() {} });
    return session;
  };
  const verify = vi.fn(async () => ({ score: 0, passed: false, details: {} }));
  components.benchmark.verify = verify;
  const result = await runTask(job, components, source, new AbortController().signal, { sensitiveValues: ["fixture-key"] });
  const directory = join(root, "runs", "run-1", "tasks", safeTaskKey("a"), "attempts", "attempt-1", "collect", "001");
  expect(await readFile(join(directory, "stdout.log"), "utf8")).toBe(code === 126 ? "bash: not found; [redacted]\n" : "capturing\n");
  expect(await readFile(join(directory, "stderr.log"), "utf8")).toBe(code === 127 ? "bash: not found; [redacted]\n" : "");
  if (code) {
    expect(verify).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("service=redis");
    expect(result.errors[0]?.message).toContain("bash: not found; [redacted]");
    expect(result.errors[0]?.message).toContain("collect/001");
  } else {
    expect(verify).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ scoreStatus: "valid", verdict: { score: 0 } });
  }
});

test("includeTaskAnswer omits the answer when the benchmark does not disclose one", async () => {
  const { components } = await taskFixture();
  const result = await runTask(job, components, source, new AbortController().signal, { includeTaskAnswer: true });
  expect(result.task).toEqual({ prompt: "Public question" });
  expect(result.task).not.toHaveProperty("answer");
  expect(JSON.stringify(result)).not.toContain("private-solution");
  expect(JSON.stringify(result)).not.toContain("taskDir");
});

test("scheduler setup receives an opened run and credential-free config before dispatch", async () => {
  const { components, config, events } = await fixture();
  let ready = false;
  const execute = components.scheduler.executeReady.bind(components.scheduler);
  components.scheduler.setup = async context => {
    expect((await context.store.snapshot()).run.runId).toBe(context.run.runId);
    expect(context.safeConfig).toEqual(config.persisted);
    expect(JSON.stringify(context)).not.toContain(config.auths.default?.value);
    ready = true;
  };
  components.scheduler.executeReady = function (...args) { expect(ready).toBe(true); return execute(...args); };
  await runEngine({ components, config, signal: new AbortController().signal });
  expect(events).toContain("solve");
});

test("scheduler setup failure marks the run error before any task is started", async () => {
  const { components, config, events } = await fixture();
  components.scheduler.setup = async () => { throw new Error("Ray handshake failed"); };
  await expect(runEngine({ components, config, signal: new AbortController().signal })).rejects.toThrow("Ray handshake failed");
  expect((await components.store.snapshot()).run.status).toBe("error");
  expect(events).not.toContain("solve");
  expect(await components.store.listAttempts()).toEqual([]);
});

test("single task projects only public input, keeps verdict and commits after cleanup", async () => {
  const { components, events, inputs } = await taskFixture();
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(inputs).toEqual([{ id: "a", prompt: "Public question" }]);
  expect(result.task).toBeUndefined();
  expect(result).toMatchObject({ executionStatus: "completed", trajectory: "agent/trajectory.jsonl", verdict: { score: 1 }, collection: { trajectory: "complete", artifacts: "not-produced" } });
  expect(result.verdict?.details).not.toHaveProperty("failedChecks");
  expect(events).toEqual(["prepare", "solve.environment", "solve", "verify", "solve.cleanup", "commit"]);
  expect((await components.store.snapshot()).records).toEqual([result]);
});

test("state transfer restores a separate verifier and disposes both before commit", async () => {
  const { components, events } = await taskFixture({ transfer: true });
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.executionStatus).toBe("completed"); expect(result.collection.artifacts).toBe("complete");
  expect(events).toEqual(["prepare", "solve.environment", "solve", "export", "verify.environment", "restore", "verify", "verify.cleanup", "solve.cleanup", "commit"]);
});

test.each(["failure", "timeout", "judge-timeout", "cancel"])("incomplete verification keeps evidence without a score after %s", async mode => {
  const { components, events } = await taskFixture();
  const controller = new AbortController();
  const secret = 'private"\\\nkey';
  components.benchmark.verify = async (_task, _result, _session, signal) => {
    if (mode === "timeout" || mode === "cancel") await new Promise<void>(resolve => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      if (mode === "cancel") controller.abort(new Error("user cancelled"));
    });
    throw new VerificationError("incomplete rubric", { grades: [{ explanation: `completed ${secret}` }],
      failedRubric: { rawOutput: `invalid ${secret}` } },
    { cause: mode === "judge-timeout" ? new DOMException("Judge request exceeded its deadline", "TimeoutError") : new SyntaxError("bad JSON") });
  };
  const record = await runTask(job, components, source, controller.signal, { timeoutSeconds: mode === "timeout" ? 0.1 : 2, sensitiveValues: [secret] });
  expect(record).toMatchObject({ executionStatus: mode === "cancel" ? "cancelled" : "failed", scoreStatus: "invalid",
    verdict: { passed: null, details: { grades: [{ explanation: "completed [redacted]" }], failedRubric: { rawOutput: "invalid [redacted]" } } } });
  expect(record.verdict).not.toHaveProperty("score");
  expect(record.errors[0]).toMatchObject({ phase: "verify" });
  if (mode === "timeout" || mode === "judge-timeout") {
    expect(attemptTimeoutKind(record)).toBe("infrastructure");
    expect(record.errors[0]?.code).toBe("VERIFY_TIMEOUT");
  }
  if (mode === "failure") expect(record.errors[0]?.code).toBe("VERIFY_RESULT_INVALID");
  expect(events).toContain("solve.cleanup");
  const snapshot = await components.store.snapshot();
  expect(snapshot.records).toEqual([record]);
  expect(JSON.stringify(snapshot)).not.toContain("private");
  expect(await new QualityScoreMetrics().compute(snapshot)).toMatchObject({ measured: 0, mean: null });
  expect(planResume(snapshot.run, await components.store.listAttempts(), job.configFingerprint)).toEqual({ skipTaskIds: [], restartTaskIds: ["a"] });
});

test.each([false, true])("persists redacted transfer warnings during normal or fallback collection: failed solve=%s", async failed => {
  const { components } = await taskFixture({ transfer: true, ...(failed ? { fail: "solve" } : {}) });
  const secret = 'PRIVATE_VALUE"\\\n';
  const prepare = components.environment.prepare.bind(components.environment);
  components.environment.prepare = async (...args) => {
    const session = await prepare(...args); const original = session.exportState.bind(session);
    session.exportState = async (...parameters) => ({ ...await original(...parameters), warnings: [{ code: "TRANSFER_UNSAFE", message: `/app/link -> /outside/${secret} (invalid-target)` }] });
    return session;
  };
  const result = await runTask(job, components, source, new AbortController().signal, { sensitiveValues: [secret] });
  expect(result.executionStatus).toBe(failed ? "failed" : "completed");
  expect(result.warnings).toEqual([{ phase: failed ? "collect" : "transfer", code: "TRANSFER_UNSAFE", message: expect.stringContaining("/app/link") }]);
  expect(JSON.stringify(result.warnings)).not.toContain("PRIVATE_VALUE");
  expect((await components.store.snapshot()).records[0]?.warnings).toEqual(result.warnings);
  if (!failed) { expect(result.errors).toEqual([]); expect(result.verdict?.score).toBe(1); }
});

test.each(["prepare", "solve.environment", "solve", "verify", "restore", "verify.environment"])("%s failures retain an error record and release prepared environments", async fail => {
  const { components, events, inputs } = await taskFixture({ fail, transfer: true });
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.executionStatus).toBe("failed");
  expect(result.scoreStatus).toBe("invalid");
  expect(result.errors[0]?.message).toContain(`injected ${fail}`);
  expect(events.at(-1)).toBe("commit"); expect((await components.store.snapshot()).records).toHaveLength(1);
  if (fail === "prepare") expect(inputs).toEqual([]);
  if (["restore", "verify.environment"].includes(fail)) expect(events).not.toContain("verify");
  if (!["prepare", "solve.environment"].includes(fail)) expect(events).toContain("solve.cleanup");
});

test("cleanup failure retains a valid verdict and is classified separately", async () => {
  const { components } = await taskFixture({ fail: "solve.cleanup" });
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", cleanupStatus: "unconfirmed" });
  expect(result.verdict?.score).toBe(1);
  expect(result.errors).toEqual([expect.objectContaining({ phase: "cleanup" })]);
});

test("both environment cleanup failures accumulate without replacing the verdict", async () => {
  const { components } = await taskFixture({ transfer: true, fail: ["solve.cleanup", "verify.cleanup"] });
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.verdict?.score).toBe(1);
  expect(result.errors.filter(error => error.phase === "cleanup")).toHaveLength(2);
});

test("missing native session is collection failure without discarding the score", async () => {
  const { components } = await taskFixture({ missingSession: true });
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", cleanupStatus: "cleaned" });
  expect(result.verdict?.score).toBe(1);
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "collect" }));
});

test("deadline and user cancellation remain distinct and cleanup gets a fresh signal", async () => {
  const first = await taskFixture({ wait: true });
  const timeout = await runTask(job, first.components, source, new AbortController().signal, { timeoutSeconds: 0.05, cleanupTimeoutMs: 1000 });
  expect(timeout.executionStatus).toBe("agent_timeout"); expect(first.events).toContain("solve.cleanup");
  expect(timeout.collection.trajectory).toBe("partial");
  expect(timeout.verdict).toBeNull(); expect(timeout.trajectory).toBe("agent/trajectory.jsonl");
  const second = await taskFixture({ wait: true }); const controller = new AbortController();
  const pending = runTask(job, second.components, source, controller.signal);
  await second.entered.promise; controller.abort();
  expect((await pending).executionStatus).toBe("cancelled"); expect(second.events).toContain("solve.cleanup");
});

test("task-specific solve timeout records SOLVER_AGENT_TIMEOUT and only collects partial state", async () => {
  const { components, events } = await taskFixture({ wait: true, transfer: true });
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { solve: 0.03 } });
  const solve = components.solver.solve.bind(components.solver);
  components.solver.solve = async (...args) => {
    try {
      return await solve(...args);
    } finally {
      events.push("solve.settled");
    }
  };
  const result = await runTask(job, components, source, new AbortController().signal, { timeoutSeconds: 2, cleanupTimeoutMs: 1000 });
  expect(result.executionStatus).toBe("agent_timeout");
  expect(result.errors[0]).toMatchObject({ phase: "solve", code: "SOLVER_AGENT_TIMEOUT", details: { originalName: "PhaseTimeoutError" } });
  expect(result.verdict).toBeNull();
  expect(events.indexOf("solve.settled")).toBeLessThan(events.indexOf("export"));
  expect(events).toContain("export");
  expect(events).not.toContain("verify.environment");
  expect(events).not.toContain("restore");
  expect(events).not.toContain("verify");
});

test("task-specific verifier deadline records an invalid infrastructure timeout and cleans the verification session", async () => {
  const { components, events } = await taskFixture({ transfer: true });
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), phaseTimeoutSeconds: { verify: 0.03 } });
  components.benchmark.verify = async (_task, _result, _session, signal) => await new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const result = await runTask(job, components, source, new AbortController().signal, { timeoutSeconds: 2, cleanupTimeoutMs: 1000 });
  expect(result.executionStatus).toBe("failed");
  expect(attemptTimeoutKind(result)).toBe("infrastructure");
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "verify", code: "VERIFY_TIMEOUT" }));
  expect(events).toContain("verify.cleanup");
});

const runtimeInstallation = { id: "fixture-runtime", files: [], commands: [], probes: [] };

test("solver runtime installation consumes the solve environment preparation budget", async () => {
  const { components, events } = await taskFixture();
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), preparationTimeoutSeconds: { solve: 0.03 } });
  components.solver.runtimeInstallation = async () => { events.push("describe"); return runtimeInstallation; };
  components.environment.supportsRuntimeInstallation = true;
  components.environment.installRuntime = async (_installation, signal) => {
    events.push("install");
    await new Promise(resolve => setTimeout(resolve, 100));
    signal.throwIfAborted();
  };
  const received: unknown[] = [];
  const prepareEnvironment = components.environment.prepare.bind(components.environment);
  components.environment.prepare = async (spec, ...rest) => { received.push(spec.installation); return await prepareEnvironment(spec, ...rest); };
  const result = await runTask(job, components, source, new AbortController().signal, { timeoutSeconds: 2, cleanupTimeoutMs: 1000 });
  expect(result.executionStatus).toBe("failed");
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "ENV_PREPARATION_TIMEOUT" }));
  expect(events).toContain("install");
  expect(events).not.toContain("solve.environment");
  expect(received).toEqual([]);
});

test("runtime installation failures are recorded in the install phase", async () => {
  const failing = await taskFixture();
  failing.components.solver.runtimeInstallation = async () => runtimeInstallation;
  failing.components.environment.supportsRuntimeInstallation = true;
  failing.components.environment.installRuntime = async () => { throw Object.assign(new Error("npm ci failed"), { code: "ENV_RUNTIME_INSTALL_FAILED" }); };
  const failed = await runTask(job, failing.components, source, new AbortController().signal);
  expect(failed.executionStatus).toBe("failed");
  expect(failed.errors).toContainEqual(expect.objectContaining({ phase: "install", code: "ENV_RUNTIME_INSTALL_FAILED" }));
  expect(failing.events).not.toContain("solve.environment");
  const unsupported = await taskFixture();
  unsupported.components.solver.runtimeInstallation = async () => runtimeInstallation;
  const rejected = await runTask(job, unsupported.components, source, new AbortController().signal);
  expect(rejected.executionStatus).toBe("failed");
  expect(rejected.errors).toContainEqual(expect.objectContaining({ phase: "install", code: "ENV_RUNTIME_INSTALL_FAILED" }));
});

test("engine locks selection in source order before any solver starts", async () => {
  const { config, components, events } = await fixture(); config.experiment.run.taskIds = ["c", "a"];
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.taskIds).toEqual(["a", "c"]); expect(snapshot.records.map(record => record.key.taskId)).toEqual(["a", "c"]);
  expect(snapshot.run.status).toBe("completed"); expect(snapshot.pendingTaskIds).toEqual([]);
  expect(events.filter(event => event === "solve")).toHaveLength(2);
});

test("unknown IDs and empty selection fail before solving", async () => {
  const first = await fixture(); first.config.experiment.run.taskIds = ["unknown"];
  await expect(runEngine({ ...first, signal: new AbortController().signal })).rejects.toThrow(/unknown/i);
  expect(first.inputs).toEqual([]);
  const second = await fixture(); second.config.experiment.run.taskIds = [];
  await expect(runEngine({ ...second, signal: new AbortController().signal })).rejects.toThrow(/empty/i);
  expect(second.inputs).toEqual([]);
});

test("store commit failure propagates as a global failure after cleanup", async () => {
  const { components, events } = await taskFixture({ fail: "commit" });
  await expect(runTask(job, components, source, new AbortController().signal)).rejects.toMatchObject({
    code: "STORE_WRITE_FAILED", cause: new Error("store unavailable"),
  });
  expect(events.at(-2)).toBe("solve.cleanup");
});

test("a solver that ignores abort cannot prevent disposal or exceed the cleanup wait budget", async () => {
  const { components, events } = await taskFixture();
  components.solver.solve = async () => new Promise(() => {});
  const result = await runTask(job, components, source, new AbortController().signal, { timeoutSeconds: 0.03, cleanupTimeoutMs: 40 });
  expect(result.executionStatus).toBe("agent_timeout");
  expect(events).toContain("solve.cleanup");
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
});

async function latePreparationFixture() {
  const value = await taskFixture({ transfer: true });
  const original = value.components.environment.prepare;
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  let solve!: EnvironmentSession; let verify!: EnvironmentSession;
  const disposeSignals: AbortSignal[] = []; const disposeWasAborted: boolean[] = [];
  value.components.environment.prepare = async (...args) => {
    const session = await original(...args);
    if (args[2] === "solve") { solve = session; session.dispose = async () => {}; return session; }
    verify = session; session.dispose = async active => { disposeSignals.push(active); disposeWasAborted.push(active.aborted); disposed.resolve(); };
    entered.resolve(); await release.promise; return session;
  };
  return { ...value, entered, release, disposed, disposeSignals, disposeWasAborted, solve: () => solve, verify: () => verify };
}

test("late preparation during the final drain snapshot is disposed without admitting post-close metadata", async () => {
  const value = await latePreparationFixture(); const controller = new AbortController();
  const splice = Array.prototype.splice; let admitted: unknown[] | undefined; let finalSnapshot = false;
  // Resolve the pending resource immediately after the last queue snapshot,
  // before that asynchronous drain returns. This deterministically exposes the
  // review race without adding timing hooks to production code.
  vi.spyOn(Array.prototype, "splice").mockImplementation(function (this: unknown[], ...args: Parameters<typeof splice>) {
    const solve = value.solve(); if (solve && this.includes(solve)) admitted = this;
    const result = splice.apply(this, args);
    if (this === admitted && result.length === 0 && !finalSnapshot) { finalSnapshot = true; value.release.resolve(); }
    return result;
  });
  const running = runTask(job, value.components, source, controller.signal, { cleanupTimeoutMs: 20 });
  await value.entered.promise; controller.abort(); const result = await running;
  expect(finalSnapshot).toBe(true); expect(value.disposeSignals).toHaveLength(1);
  expect(value.disposeWasAborted).toEqual([false]);
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
  expect(result.environments.verify).toBeNull();
  expect((await value.components.store.snapshot()).records).toEqual([result]);
});

test("a late session admitted at cleanup budget expiry still receives disposal with a fresh signal", async () => {
  const value = await latePreparationFixture(); const controller = new AbortController(); const cleanup = new AbortController();
  const originalTimeout = AbortSignal.timeout; let firstTimeout = true;
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    if (!firstTimeout) return originalTimeout(milliseconds);
    firstTimeout = false;
    // Register before bounded's cancellation listener, so preparation completes
    // as the cleanup wait expires and is admitted before the final queue drain.
    cleanup.signal.addEventListener("abort", () => value.release.resolve(), { once: true });
    return cleanup.signal;
  });
  const running = runTask(job, value.components, source, controller.signal, { cleanupTimeoutMs: 50 });
  await value.entered.promise; controller.abort();
  await new Promise<void>(done => setImmediate(done)); cleanup.abort(new DOMException("Cleanup deadline", "TimeoutError"));
  const result = await running;
  expect(result.environments.verify).toEqual(value.verify().metadata);
  expect(value.disposeSignals).toHaveLength(1); expect(value.disposeWasAborted).toEqual([false]);
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
});

test("preparation after publication gets bounded disposal and cannot mutate the committed record", async () => {
  const value = await latePreparationFixture(); const controller = new AbortController();
  const running = runTask(job, value.components, source, controller.signal, { cleanupTimeoutMs: 20 });
  await value.entered.promise; controller.abort(); const result = await running;
  expect(result.errors).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
  const published = structuredClone(result); const disposalEntered = Promise.withResolvers<AbortSignal>();
  value.verify().dispose = async active => { disposalEntered.resolve(active); await new Promise(() => {}); };
  value.release.resolve(); const disposalSignal = await disposalEntered.promise;
  expect(disposalSignal.aborted).toBe(false);
  await new Promise<void>(done => disposalSignal.addEventListener("abort", () => done(), { once: true }));
  expect(result).toEqual(published); expect((await value.components.store.snapshot()).records).toEqual([published]);
});

test("an unresponsive known session records its ID and unconfirmed cleanup without later record mutation", async () => {
  const { components } = await taskFixture(); const prepare = components.environment.prepare;
  const releaseDisposal = Promise.withResolvers<void>(); let called = false;
  components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    session.dispose = async active => { expect(active.aborted).toBe(false); called = true; await releaseDisposal.promise; };
    return session;
  };
  const result = await runTask(job, components, source, new AbortController().signal, { cleanupTimeoutMs: 20 });
  expect(called).toBe(true);
  expect(result).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", cleanupStatus: "unconfirmed" });
  expect(result.verdict?.score).toBe(1);
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "cleanup", code: "CLEANUP_TIMEOUT", message: expect.stringContaining("solve-id") }));
  const published = structuredClone(result); releaseDisposal.resolve(); await new Promise<void>(done => setImmediate(done));
  expect(result).toEqual(published); expect((await components.store.snapshot()).records).toEqual([published]);
});

test("a valid JSON end event without its final newline is partial evidence", async () => {
  const { components } = await taskFixture(); const solve = components.solver.solve;
  components.solver.solve = async (...args) => {
    const result = await solve(...args); const path = join(args[2].paths.agent, "trajectory.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).trimEnd()); return result;
  };
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.executionStatus).toBe("completed"); expect(result.scoreStatus).toBe("valid"); expect(result.collection.trajectory).toBe("partial");
  expect(result.verdict?.score).toBe(1);
});

test("an evidence checksum read failure becomes a missing entry and still commits the verdict", async () => {
  artifactReadFailure.suffix = "/agent/session.jsonl";
  const { components, events, root } = await taskFixture();
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.verdict?.score).toBe(1);
  expect(result.executionStatus).toBe("completed"); expect(result.scoreStatus).toBe("valid");
  expect(result.collection.trajectory).toBe("partial");
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "collect" }));
  expect(events.at(-1)).toBe("commit");
  const files = JSON.parse(await readFile(join(root, "runs", job.runId, "tasks", safeTaskKey(job.taskId), "attempts", result.key.attemptId, "files.json"), "utf8"));
  expect(files.missing).toContainEqual({ path: "agent/session.jsonl", reason: expect.stringContaining("EIO") });
  expect((await components.store.snapshot()).records).toEqual([result]);
});

test("an evidence read failure followed by disappearance still commits the verdict", async () => {
  artifactReadFailure.suffix = "/agent/session.jsonl"; artifactReadFailure.removeOnFailure = true;
  const { components, events, root } = await taskFixture();
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.verdict?.score).toBe(1);
  expect(result.executionStatus).toBe("completed"); expect(result.scoreStatus).toBe("valid");
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "collect" }));
  expect(events.at(-1)).toBe("commit");
  const files = JSON.parse(await readFile(join(root, "runs", job.runId, "tasks", safeTaskKey(job.taskId), "attempts", result.key.attemptId, "files.json"), "utf8"));
  expect(files.missing).toContainEqual({ path: "agent/session.jsonl", reason: expect.stringContaining("EIO") });
  expect((await components.store.snapshot()).records).toEqual([result]);
});

test("a trajectory inspection open failure is partial and still commits the hashed file", async () => {
  artifactReadFailure.suffix = "/agent/trajectory.jsonl"; artifactReadFailure.failOnCall = 2;
  const { components, events, root } = await taskFixture();
  const result = await runTask(job, components, source, new AbortController().signal);
  expect(result.verdict?.score).toBe(1);
  expect(result.executionStatus).toBe("completed"); expect(result.scoreStatus).toBe("valid");
  expect(result.collection.trajectory).toBe("partial");
  expect(result.errors).toContainEqual(expect.objectContaining({ phase: "collect" }));
  expect(events.at(-1)).toBe("commit");
  const files = JSON.parse(await readFile(join(root, "runs", job.runId, "tasks", safeTaskKey(job.taskId), "attempts", result.key.attemptId, "files.json"), "utf8"));
  expect(files.files).toContainEqual(expect.objectContaining({ path: "agent/trajectory.jsonl" }));
});

test("a task failure aborts the run and leaves the remaining tasks pending", async () => {
  const { components, config } = await fixture(); components.scheduler = new LocalScheduler(1);
  const prepare = components.benchmark.prepare;
  components.benchmark.prepare = async (...args) => {
    if (args[0].id === "b") throw new Error("bad row"); return prepare(...args);
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  // Fail-fast is decided before the scheduler can replenish the completed slot.
  expect(snapshot.records.map(record => [record.key.taskId, record.executionStatus])).toEqual([["a", "completed"], ["b", "failed"]]);
  expect(snapshot.run.taskIds).toEqual(["a", "b", "c"]); expect(snapshot.run.status).toBe("error");
  expect(snapshot.pendingTaskIds).toEqual(["c"]);
});

test("run.onError=continue keeps running the remaining tasks after a failure", async () => {
  const { components, config } = await fixture(); const prepare = components.benchmark.prepare;
  config.experiment.run.onError = "continue";
  components.benchmark.prepare = async (...args) => {
    if (args[0].id === "b") throw new Error("bad row"); return prepare(...args);
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.records.map(record => [record.key.taskId, record.executionStatus])).toEqual([["a", "completed"], ["b", "failed"], ["c", "completed"]]);
  expect(snapshot.run.status).toBe("error"); expect(snapshot.pendingTaskIds).toEqual([]);
});

test.each([false, true])("WorkBuddy submission zero or environment failure keeps later tasks and publishes the report: %s", async environmentFailure => {
  const { components, config } = await fixture();
  config.experiment.run.taskIds = ["a", "b"];
  config.experiment.run.onError = "continue";
  components.scheduler = new LocalScheduler(1);
  components.benchmark.verify = async task => {
    if (task.input.id === "b") return { score: 1, passed: true, details: {} };
    if (environmentFailure) throw new VerificationError("BlockingPortal dependency collection error", { test_status: "build_error" });
    return scoreHarborEvidence({ rewards: { reward: 0 }, details: {
      native: { test_status: "build_error" },
      evaluator: { kind: "submission-validation-failure", scoreOrigin: "evaluator-failure-fallback", reason: "KeyError: missing submission column" },
    } }, { primary: "reward", passThreshold: 1, errorValues: [] });
  };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.pendingTaskIds).toEqual([]);
  expect(snapshot.records[1]).toMatchObject({ key: { taskId: "b" }, executionStatus: "completed", scoreStatus: "valid" });
  expect(snapshot.run.status).toBe(environmentFailure ? "error" : "completed");
  const metrics = [new HarborScoreMetrics({ dimensions: [] }), new SuccessRateMetrics()];
  await saveReport(components.store, metrics, new MarkdownReporter());
  const runDirectory = join(config.experiment.output.directory, snapshot.run.runId);
  const report = await readFile(join(runDirectory, "report.md"), "utf8");
  const values = JSON.parse(await readFile(join(runDirectory, "metrics.json"), "utf8"));
  expect(values.metrics["harbor-score"]).toMatchObject({ denominator: environmentFailure ? 1 : 2,
    invalid: environmentFailure ? 1 : 0, meanReward: environmentFailure ? 1 : 0.5 });
  if (environmentFailure) {
    expect(report).toContain("未完成");
    expect(report).not.toContain("## 提交错误计零分");
  } else {
    expect(snapshot.records[0]).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 0, passed: false } });
    expect(report).toContain("## 提交错误计零分");
    expect(report).toContain("KeyError: missing submission column");
  }
});

test("engine cancellation persists the started attempt and keeps queued tasks pending", async () => {
  const { components, config, entered } = await fixture({ wait: true }); components.scheduler = new LocalScheduler(1);
  const controller = new AbortController(); const running = runEngine({ components, config, signal: controller.signal });
  await entered.promise; controller.abort(); const snapshot = await running;
  expect(snapshot.run.status).toBe("cancelled"); expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]?.executionStatus).toBe("cancelled"); expect(snapshot.pendingTaskIds).toEqual(["a", "b", "c"]);
});

test("new runs expose the actual evaluator package identity and host runtime", async () => {
  const { config, components } = await fixture();
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.identity).toEqual({
    evaluator: { name: pkg.name, version: pkg.version },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  });
});

test("a benchmark verifier without a score still completes a score-free run", async () => {
  const { config, components } = await fixture();
  const verify = components.benchmark.verify.bind(components.benchmark);
  components.benchmark.verify = async (...args) => { const { score: _score, ...rest } = await verify(...args); return rest; };
  const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("completed");
  expect(snapshot.records.length).toBeGreaterThan(0);
  for (const record of snapshot.records) {
    expect(record.verdict).toMatchObject({ passed: true, details: {} }); expect(record.verdict).not.toHaveProperty("score");
  }
});

test("model authentication failure stops dispatch even with onError=continue", async () => {
  const { config, components, events } = await fixture();
  components.scheduler = new LocalScheduler(1);
  config.experiment.run.onError = "continue";
  components.solver.solve = async () => { events.push("auth-request"); throw new EvaluatorError("MODEL_AUTH_FAILED", "forbidden"); };
  const snapshot = await runEngine({ config, components, signal: new AbortController().signal });
  expect(events.filter(event => event === "auth-request")).toHaveLength(1);
  expect(snapshot.records[0]).toMatchObject({ executionStatus: "failed", scoreStatus: "invalid" });
  expect(snapshot.records[0]?.errors).toContainEqual(expect.objectContaining({ code: "MODEL_AUTH_FAILED", action: "abort_run" }));
  expect(snapshot.pendingTaskIds).toEqual(["b", "c"]);
  expect(snapshot.run.status).toBe("error");
});

test("transfer stage timeout does not qualify as network recovery", async () => {
  const { config, components, events } = await fixture({ transfer: true });
  config.experiment.run.taskIds = ["a"];
  const prepare = components.environment.prepare;
  let restores = 0;
  components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    const restore = session.restoreState;
    session.restoreState = async (...parameters) => {
      if (restores++ === 0) throw new EvaluatorError("TRANSFER_TIMEOUT", "copy deadline");
      return await restore(...parameters);
    };
    return session;
  };
  const snapshot = await runEngine({ config, components, signal: new AbortController().signal });
  expect(snapshot.run.status).toBe("error");
  expect(snapshot.records[0]?.verdict).toBeNull();
  const attempts = await components.store.listAttempts();
  expect(attempts.map(attempt => attempt.record?.executionStatus)).toEqual(["failed"]);
  expect(events.filter(event => event === "solve")).toHaveLength(1);
});

test("resume recovers scored but unconfirmed resources without solving the task again", async () => {
  const { config, components, events } = await fixture({ fail: "solve.cleanup" });
  config.experiment.run.taskIds = ["a"];
  const first = await runEngine({ config, components, signal: new AbortController().signal });
  expect(first.records[0]).toMatchObject({ scoreStatus: "valid", cleanupStatus: "unconfirmed" });
  const recover = vi.fn(async () => {});
  components.environment.recoverAttempts = recover;
  await components.store.close();
  const resumed = await runEngine({ config, components, signal: new AbortController().signal,
    resumeDirectory: join(config.experiment.output.directory, first.run.runId) });
  expect(recover).toHaveBeenCalledWith([first.records[0]!.key], expect.any(AbortSignal));
  expect(events.filter(event => event === "solve")).toHaveLength(1);
  expect(resumed.records).toEqual(first.records);
  // Recovery does not rewrite the original cleanup observation.
  expect(resumed.run.status).toBe("error");
});

test("resume cannot silently skip unconfirmed resources without a recovery implementation", async () => {
  const { config, components } = await fixture({ fail: "solve.cleanup" });
  config.experiment.run.taskIds = ["a"];
  const first = await runEngine({ config, components, signal: new AbortController().signal });
  await components.store.close();
  await expect(runEngine({ config, components, signal: new AbortController().signal,
    resumeDirectory: join(config.experiment.output.directory, first.run.runId) })).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
});

test.each(["solve", "verify"] as const)("malformed %s output becomes a task diagnostic before store commit", async phase => {
  const { components, events } = await taskFixture();
  if (phase === "solve") {
    const solve = components.solver.solve;
    components.solver.solve = async (...args) => ({ ...await solve(...args), usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } });
  } else components.benchmark.verify = async () => ({ score: NaN, passed: true, details: {} });
  const record = await runTask(job, components, source, new AbortController().signal);
  expect(record).toMatchObject({ executionStatus: "failed", scoreStatus: "invalid", verdict: null });
  expect(record.errors[0]).toMatchObject({ phase, code: phase === "solve" ? "SOLVER_PROTOCOL_INVALID" : "VERIFY_RESULT_INVALID", retryable: false });
  expect(events.at(-1)).toBe("commit");
});
