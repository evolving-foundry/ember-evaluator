import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { consumeJiuwenswarm } from "../../src/runtimes/jiuwenswarm/protocol.js";
import type { ProcessHandle } from "../../src/core/contracts/environment.js";
import { runEngine } from "../../src/application/run-engine.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";
import { dshStream, interruptedResponse } from "../fixtures/engine/dsh-stream.js";

const fixtures: { root: string; value: ReturnType<typeof harness> }[] = [];
async function fixture(errorFor: (task: string, count: number) => string | undefined) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-retry-"));
  const value = harness(root);
  fixtures.push({ root, value });
  value.components.scheduler = new LocalScheduler(1);
  const calls = new Map<string, number>();
  value.components.solver.solve = async (input, _session, context) => {
    const count = (calls.get(input.id) ?? 0) + 1;
    calls.set(input.id, count);
    return consumeDsh(dshStream(errorFor(input.id, count)), context, "fixture-key");
  };
  return { ...value, calls };
}

async function jiuwenswarmFixture(errorFor: (count: number, taskId: string) => string | undefined, emptyLengthGuard = false) {
  const value = await fixture(() => undefined);
  value.config.experiment.run.taskIds = ["a"];
  value.components.solver.solve = async (input, _session, context) => {
    const count = (value.calls.get(input.id) ?? 0) + 1;
    value.calls.set(input.id, count);
    const error = errorFor(count, input.id);
    const events = [{ channel_id: "process_cli", ok: true,
      payload: { event_type: "chat.delta", content: "Collected partial evidence" } },
      { channel_id: "process_cli", ok: error === undefined, payload: error === undefined
        ? { event_type: "chat.final", content: "Answer: 42" }
        : emptyLengthGuard
          ? { event_type: "chat.error", error_type: "EmptyLengthResponseError", error }
          : { event_type: "runtime.error", error } }];
    const handle: ProcessHandle = {
      stdout: (async function* () { yield Buffer.from(JSON.stringify({ ok: error === undefined, events })); })(),
      stderr: (async function* () { yield Buffer.from(`attempt ${count} fixture-key`); })(),
      done: Promise.resolve({ code: error === undefined ? 0 : 124, signal: null }),
      async stop() {},
    };
    return consumeJiuwenswarm(handle, context, "fixture-key");
  };
  return value;
}
afterEach(async () => {
  for (const { root, value } of fixtures.splice(0)) {
    await value.components.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

const emptyLengthFailure = "EMPTY_TRUNCATED_MODEL_RESPONSE: recovery-exhausted; recovery limit=1";

test("Local parallel architecture failures are unscored without retry and preserve other completed tasks", async () => {
  const value = await fixture(() => undefined);
  value.components.scheduler = new LocalScheduler(2);
  value.config.experiment.run.onError = "continue";
  const prepareTask = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => {
    const task = await prepareTask(...args);
    task.solveEnv.image = task.input.id;
    return task;
  };
  const prepareEnvironment = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    if (args[0].image === "b") throw new EvaluatorError("ENV_ARCH_UNSUPPORTED", "QEMU/binfmt unavailable");
    return prepareEnvironment(...args);
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  const records = new Map(result.records.map(record => [record.key.taskId, record]));
  expect(records.get("b")).toMatchObject({ scoreStatus: "invalid", verdict: null,
    errors: [expect.objectContaining({ code: "ENV_ARCH_UNSUPPORTED", category: "infrastructure", retryable: false })] });
  for (const id of ["a", "c"]) expect(records.get(id)).toMatchObject({ executionStatus: "completed", verdict: { score: 1 } });
  expect(await value.components.store.listAttempts()).toHaveLength(3);
  expect(computeSuccessRate(await value.components.store.snapshot())).toMatchObject({ denominator: 2, invalid: 1, rate: 1 });
});

test("typed truncation is not eligible for network recovery", async () => {
  const value = await jiuwenswarmFixture(() => emptyLengthFailure, true);
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
  expect(await value.components.store.listAttempts()).toHaveLength(1);
});

test("cleanup failure after typed truncation remains authoritative and prevents another environment", async () => {
  const value = await jiuwenswarmFixture(() => emptyLengthFailure, true);
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    const dispose = session.dispose.bind(session);
    session.dispose = async signal => { await dispose(signal); throw new Error("cleanup failed"); };
    return session;
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
  expect(result.records[0]?.errors).toContainEqual(expect.objectContaining({ phase: "cleanup", code: "CLEANUP_FAILED" }));
  expect(await value.components.store.listAttempts()).toHaveLength(1);
});

test("DSH truncation creates a fresh attempt before honoring run.onError=abort", async () => {
  const value = await fixture((task, count) => task === "a" && count === 1 ? interruptedResponse + " fixture-key" : undefined);
  const progress: string[] = [];
  const result = await runEngine({ ...value, signal: new AbortController().signal,
    onProgress: event => { if (event.phase === "retry") progress.push(event.message); } });
  expect(result.run.status).toBe("completed");
  expect([...value.calls.entries()]).toEqual([["a", 2], ["b", 1], ["c", 1]]);
  const attempts = await value.components.store.listAttempts();
  expect(attempts).toHaveLength(4);
  const failed = attempts.find(attempt => attempt.record?.executionStatus === "failed")!;
  expect(failed.record?.errors[0]).toMatchObject({ code: "NETWORK_FAILURE", phase: "solve", details: { originalCode: "SOLVER_RESULT_INCOMPLETE" } });
  const causes = JSON.stringify(failed.record?.errors[0]?.causes);
  expect(causes).toContain("APIConnectionError");
  expect(causes).toContain("TransferEncodingError: 400");
  expect(causes).toContain("[redacted]");
  expect(JSON.stringify(attempts)).not.toContain("fixture-key");
  expect(failed.record?.collection.trajectory).toBe("partial");
  expect(result.records.every(record => record.executionStatus === "completed")).toBe(true);
  expect(progress).toHaveLength(1);
  expect(value.events.filter(event => event === "solve.cleanup")).toHaveLength(4);
  expect(value.events.filter(event => event === "verify")).toHaveLength(3);
});

test("only truncated tasks repeat while continue mode executes other tasks", async () => {
  const value = await fixture((task, count) => task === "a" && count === 1 ? interruptedResponse
    : task === "b" ? "HTTP 400 Bad Request: invalid model parameter" : undefined);
  value.config.experiment.run.onError = "continue";
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect([...value.calls.entries()]).toEqual([["a", 2], ["b", 1], ["c", 1]]);
  expect(result.records.map(record => record.executionStatus)).toEqual(["completed", "failed", "completed"]);
});

test("persistent truncation stops after three invalid attempts", async () => {
  const value = await fixture(() => interruptedResponse);
  value.config.experiment.run.taskIds = ["a"];
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(3);
  const attempts = await value.components.store.listAttempts();
  expect(attempts.map(attempt => attempt.ordinal)).toEqual([1, 2, 3]);
  expect(new Set(attempts.map(attempt => attempt.key.attemptId)).size).toBe(3);
  expect(attempts.every(attempt => attempt.record?.scoreStatus === "invalid" && attempt.record.verdict === null && attempt.record.cleanupStatus === "cleaned")).toBe(true);
  expect(value.events.filter(event => event === "verify")).toHaveLength(0);
});

test("Swarm truncation retries the entire task and succeeds on the third attempt", async () => {
  const value = await jiuwenswarmFixture(count => count < 3 ? "peer closed connection without sending complete message body (incomplete chunked read)" : undefined);
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(value.calls.get("a")).toBe(3);
  expect((await value.components.store.listAttempts()).map(attempt => attempt.record?.scoreStatus)).toEqual(["invalid", "invalid", "valid"]);
});

test("coordinator retries persisted scheduler results without relying on its local executor", async () => {
  const value = await fixture((_task, count) => count === 1 ? interruptedResponse : undefined);
  value.config.experiment.run.taskIds = ["a"];
  const scheduler = new LocalScheduler(1);
  value.components.scheduler = {
    executionLocation: "remote",
    executeReady(jobs, _executor, signal) {
      // Like Ray, execute outside the coordinator's executor and return the
      // persisted result. This tests admission, not Ray transport or deployment.
      return scheduler.executeReady(jobs, (job, taskSignal) => runTask(job, value.components, source, taskSignal), signal);
    },
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(value.calls.get("a")).toBe(2);
  expect(await value.components.store.listAttempts()).toHaveLength(2);
});

test("DeepAgents protocol truncation restarts in fresh workspaces and repeats earlier tools", async () => {
  const value = await fixture(() => undefined);
  value.config.experiment.run.taskIds = ["a"];
  const workspaces: string[] = [];
  let tools = 0;
  value.components.solver.solve = async (_input, session, context) => {
    workspaces.push(session.workdir);
    const marker = join(session.workdir, "tool-marker");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(marker, String(++tools));
    return consumeDsh(dshStream(tools < 3 ? "incomplete chunked read" : undefined), context, "fixture-key", undefined, "DEEPAGENTS");
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(tools).toBe(3);
  expect(new Set(workspaces).size).toBe(3);
  expect(value.events.filter(event => event === "solve.cleanup")).toHaveLength(3);
});

test("cleanup failure prevents whole-task stream recovery", async () => {
  const value = await fixture(() => interruptedResponse);
  value.config.experiment.run.taskIds = ["a"];
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    const dispose = session.dispose.bind(session);
    session.dispose = async signal => { await dispose(signal); throw new Error("cleanup failed"); };
    return session;
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
  expect(result.records[0]?.cleanupStatus).toBe("unconfirmed");
});

test("cancellation stops a queued automatic retry and resume retains the consumed budget", async () => {
  const value = await fixture(() => interruptedResponse);
  value.config.experiment.run.taskIds = ["a"];
  const controller = new AbortController();
  const first = await runEngine({ ...value, signal: controller.signal, onProgress: event => {
    if (event.phase === "retry") controller.abort(new Error("user cancelled"));
  } });
  expect(first.run.status).toBe("cancelled");
  expect(value.calls.get("a")).toBe(1);
  const resumeDirectory = join(value.config.experiment.output.directory, first.run.runId);
  await value.components.store.close();
  const resumed = await runEngine({ ...value, resumeDirectory, signal: new AbortController().signal });
  expect(resumed.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(3);
  expect(await value.components.store.listAttempts()).toHaveLength(3);
});

test("stream idle timeout ends the attempt when the harness exhausts its request retries", async () => {
  const value = await fixture((_task, count) => count === 1 ? "pi-ai stream idle timeout after 300000ms" : undefined);
  value.config.experiment.run.taskIds = ["a"];
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
});

test("a missing final with explicit truncation restarts the task", async () => {
  const value = await fixture(() => undefined);
  value.config.experiment.run.taskIds = ["a"];
  let count = 0;
  value.components.solver.solve = (_input, _session, context) =>
    consumeDsh(dshStream(++count === 1 ? interruptedResponse : undefined, count !== 1), context, "fixture-key");
  expect((await runEngine({ ...value, signal: new AbortController().signal })).run.status).toBe("completed");
  expect(count).toBe(2);
});

test("a process CLI Agent deadline finalizes a valid zero and preserves partial artifacts", async () => {
  const value = await jiuwenswarmFixture(count => count === 1 ? "process CLI execution timed out" : undefined);
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("completed");
  expect(value.calls.get("a")).toBe(1);
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ executionStatus: "agent_timeout", scoreStatus: "valid" });
  const attempts = await value.components.store.listAttempts();
  expect(attempts.map(attempt => attempt.ordinal)).toEqual([1]);
  expect(attempts[0]?.record).toMatchObject({ executionStatus: "agent_timeout", solve: null, verdict: null,
    errors: [{ phase: "solve", code: "SOLVER_AGENT_TIMEOUT", message: expect.stringContaining("process CLI execution timed out") }],
    warnings: [{ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE" }] });
  for (const attempt of attempts) {
    const agent = join(value.config.experiment.output.directory, result.run.runId, "tasks",
      safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "agent");
    expect(await readFile(join(agent, "stderr.log"), "utf8")).toContain("[redacted]");
    expect(await readFile(join(agent, "trajectory.jsonl"), "utf8")).toContain("Collected partial evidence");
  }
  expect(value.events.filter(event => event === "solve.cleanup")).toHaveLength(1);
});

test("process CLI permanent errors do not retry", async () => {
  const value = await jiuwenswarmFixture(() => "AuthenticationError: invalid api key");
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
  expect(result.records[0]?.errors[0]?.code).toBe("MODEL_AUTH_FAILED");
});

test("a cleanup failure accompanying a process CLI deadline prevents automatic retry", async () => {
  const value = await jiuwenswarmFixture(() => "process CLI execution timed out");
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    const dispose = session.dispose.bind(session);
    session.dispose = async signal => { await dispose(signal); throw new Error("cleanup failed"); };
    return session;
  };
  const result = await runEngine({ ...value, signal: new AbortController().signal });
  expect(result.run.status).toBe("error");
  expect(value.calls.get("a")).toBe(1);
  expect(result.records[0]?.errors).toContainEqual(expect.objectContaining({ phase: "cleanup", code: "CLEANUP_FAILED" }));
  expect(await value.components.store.listAttempts()).toHaveLength(1);
});
