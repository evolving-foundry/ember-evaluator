import { PhaseTimeoutError } from "../../src/core/policies/phase-timeout.js";
import { classifyError } from "../../src/core/errors/classify.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RayResult } from "../../src/infrastructure/ray/client.js";
import type { RemoteJob } from "../../src/infrastructure/ray/protocol.js";
import { RayScheduler } from "../../src/plugins/schedulers/ray/scheduler.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { storeRun, storeRecord } from "../fixtures/results/store-fixture.js";
import { computeSuccessRate } from "../../src/plugins/metrics/success-rate.js";

const bridge = vi.hoisted(() => ({ submit: vi.fn<(job: RemoteJob) => Promise<RayResult>>(),
  cleanupAttempt: vi.fn(async () => {}), cancel: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock("../../src/infrastructure/ray/client.js", () => ({ RayClient: class {
  nodes = ["node"]; nodeSlots = { node: 2 }; slots = 2;
  start = async () => {};
  submit = bridge.submit; cleanupAttempt = bridge.cleanupAttempt; cancel = bridge.cancel; close = bridge.close;
} }));
vi.mock("../../src/infrastructure/provenance/package.js", () => ({ PACKAGE_RUNTIME_ID: "ember-evaluator:package", loadPackageDigest: async () => `sha256:${"a".repeat(64)}` }));
vi.mock("../../src/infrastructure/transfer/https.js", () => ({ startTransferReceiver: async () => ({ url: "https://collector.invalid", close: async () => {} }) }));

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("TEST_RAY_TIMEOUT_TOKEN", "fixture-transfer-token"); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });
async function fixture(taskIds = ["a"], concurrency?: number) {
  const root = await mkdtemp(join(tmpdir(), "ray-timeout-outcomes-"));
  const store = new LocalRunStore();
  cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const certFile = join(root, "certificate.pem");
  await writeFile(certFile, "fixture");
  const run = { ...storeRun, taskIds, pluginVersions: { "ember-evaluator:package": `sha256:${"a".repeat(64)}` } };
  const safeConfig = {
    benchmark: { name: "fixture", config: {} }, environment: { name: "docker", config: { platform: "auto" } },
    solver: { name: "fixture", config: {}, service: "default" },
    run: { maxTasks: null, taskIds, timeoutSeconds: 10, onError: "continue" },
    output: { directory: root },
  };
  await store.create(root, run, safeConfig);
  const scheduler = new RayScheduler({ endpoint: "local", pythonExecutable: "unused", startupTimeoutMs: 1000,
    ...(concurrency === undefined ? {} : { concurrency }),
    heartbeatTimeoutMs: 1000, cancelGraceMs: 1000,
    collector: { certFile, keyFile: certFile, tokenEnv: "TEST_RAY_TIMEOUT_TOKEN", host: "127.0.0.1", port: 0 } },
    { services: { default: { model: { name: "fixture", api: "openai-completions", provider: null, endpoint: null },
      auth: { value: "fixture-model-key", reference: null } } }, solverService: "default", configDirectory: root, resolvePath: path => path });
  const log = vi.fn();
  await scheduler.setup({ run, store, safeConfig, log }, new AbortController().signal);
  const job = { runId: run.runId, taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" }, configFingerprint: run.configFingerprint };
  const execute = async () => {
    const records = [];
    const jobs = taskIds.map(taskId => ({ ...job, taskId, ref: { id: taskId, recordKey: taskId } }));
    for await (const record of scheduler.executeReady((async function* () { yield* jobs; })(), async () => { throw new Error("Ray must not call coordinator executor"); }, new AbortController().signal)) records.push(record);
    return records;
  };
  const prepare = async () => scheduler.prepareTasks(taskIds.map(taskId => ({ ...job, taskId, ref: { id: taskId, recordKey: taskId } })), {
    tasks: taskIds.map(id => ({ input: { id, prompt: "question" }, verification: {},
      solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null })),
    policy: { version: "1", source: "fixture" }, preparation: { defaultTimeoutSeconds: 60 },
  }, { previous: [], sensitiveValues: [], onError: "continue", store, prepareTask: async () => { throw new Error("Coordinator cannot prepare node resources"); } }, new AbortController().signal);
  return { store, execute, scheduler, log, prepare };
}

test("acknowledged non-network node failure is cleaned and never retried by the scheduler", async () => {
  const { store, execute } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId, code: "RAY_WORKER_LOST", originalName: "RayTaskError", retired: true }));
  const result = await execute();
  expect(bridge.submit).toHaveBeenCalledTimes(1);
  expect(bridge.cleanupAttempt).toHaveBeenCalledTimes(1);
  expect((await store.listAttempts()).map(attempt => attempt.record?.executionStatus)).toEqual(["failed"]);
  expect(result[0]?.executionStatus).toBe("failed");
});

test("lost worker with unconfirmed process exit is invalid and cannot blindly retry", async () => {
  const { store, execute } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId, code: "RAY_WORKER_LOST", originalName: "WorkerCrashedError", retired: false }));
  const result = await execute();
  expect(bridge.submit).toHaveBeenCalledTimes(1);
  expect(bridge.cleanupAttempt).not.toHaveBeenCalled();
  expect(result[0]?.errors).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
  expect((await store.snapshot()).pendingTaskIds).toEqual([]);
});

test("a worker's explicit preparation error is preserved and never retried", async () => {
  const { execute } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId, code: "ENV_ARCH_UNSUPPORTED", retired: true }));
  const result = await execute();
  expect(bridge.submit).toHaveBeenCalledTimes(1);
  expect(result[0]?.errors[0]).toMatchObject({ code: "ENV_ARCH_UNSUPPORTED", retryable: false, action: "finalize" });
});

test("Ray batch preparation preserves a worker architecture failure code", async () => {
  const { prepare, store } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId, code: "ENV_ARCH_UNSUPPORTED", retired: true }));
  await prepare();
  expect((await store.snapshot()).run.preparationRounds?.[0]?.tasks?.[0]?.failure).toMatchObject({ code: "ENV_ARCH_UNSUPPORTED" });
  expect(bridge.submit).toHaveBeenCalledTimes(1);
});

test("Ray shows a worker emulation warning without failing preparation", async () => {
  const { prepare, log } = await fixture();
  const warning = "QEMU 模拟可能产生性能损耗";
  bridge.submit.mockImplementation(async remote => ({ type: "prepared", attemptId: remote.job.attemptId,
    result: { preparationDigest: "a".repeat(64), nodeId: "node", hostname: "host", warnings: [warning] } }));
  await prepare();
  expect(log).toHaveBeenCalledWith(`[warn] [environment] a: ${warning}`);
  expect(bridge.submit).toHaveBeenCalledTimes(1);
});

test("Ray preparation entry records the node barrier without materializing on the coordinator", async () => {
  const { scheduler, store } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "prepared", attemptId: remote.job.attemptId,
    result: { preparationDigest: "a".repeat(64), nodeId: "node", hostname: "host" } }));
  const task = { input: { id: "a", prompt: "question" }, verification: {},
    solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null };
  const plan = { tasks: [task], policy: { version: "1", source: "fixture" }, preparation: { defaultTimeoutSeconds: 60  }};
  const prepareTask = vi.fn(async () => { throw new Error("Coordinator cannot prepare node resources"); });
  const prepared = await scheduler.prepareTasks([
    { runId: "run-1", taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" }, configFingerprint: "config-hash" },
  ], plan, { previous: [], sensitiveValues: [], store, prepareTask }, new AbortController().signal);
  expect(prepared.tasks).toEqual([task]);
  expect(prepareTask).not.toHaveBeenCalled();
  expect((await store.snapshot()).run.preparationRounds?.[0]).toMatchObject({ status: "ready",
    placements: [{ taskId: "a", nodeId: "node", digest: "a".repeat(64) }] });
});

test.each([
  { preparation: undefined, execution: undefined, expected: 2 },
  { preparation: undefined, execution: 1, expected: 1 },
  { preparation: 4, execution: 1, expected: 2 },
])("Ray preparation $preparation with execution $execution respects its node limit", async ({ preparation: concurrency, execution, expected }) => {
  const { scheduler, store } = await fixture(["a", "b", "c"], execution);
  const jobs = ["a", "b", "c"].map(taskId => ({ runId: "run-1", taskId, attemptId: `first-${taskId}`,
    ref: { id: taskId, recordKey: taskId }, configFingerprint: "config-hash" }));
  const plan = { tasks: jobs.map(job => ({ input: { id: job.taskId, prompt: "question" }, verification: {},
    solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null })),
    policy: { version: "1", source: "fixture" }, preparation: { defaultTimeoutSeconds: 60  }};
  const gates = new Map(jobs.map(job => [job.taskId, Promise.withResolvers<void>()]));
  const started: string[] = [];
  let active = 0, maximum = 0, settled = false;
  bridge.submit.mockImplementation(async remote => {
    started.push(remote.job.taskId);
    maximum = Math.max(maximum, ++active);
    try { await gates.get(remote.job.taskId)!.promise; } finally { active--; }
    return { type: "prepared", attemptId: remote.job.attemptId,
      result: { preparationDigest: "a".repeat(64), nodeId: "node", hostname: "host" } };
  });
  const running = scheduler.prepareTasks(jobs, plan, { previous: [], sensitiveValues: [], store,
    ...(concurrency === undefined ? {} : { settings: { mode: "batch", concurrency } }),
    prepareTask: async task => task,
  }, new AbortController().signal).finally(() => { settled = true; });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(expected));
    expect(settled).toBe(false);
    if (expected === 2) {
      gates.get("b")!.resolve();
      await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
      gates.get("c")!.resolve();
    }
    expect(settled).toBe(false);
  } finally { for (const gate of gates.values()) gate.resolve(); }
  expect((await running).tasks?.map(task => task.input.id)).toEqual(["a", "b", "c"]);
  expect(maximum).toBe(expected);
  expect((await store.snapshot()).run.preparationRounds?.[0]?.concurrency ?? 1).toBe(maximum);
});

test("Ray rejects lookahead in batch mode", async () => {
  const { scheduler, store } = await fixture();
  await expect(scheduler.prepareTasks([], { tasks: [], policy: { version: "1", source: "fixture" }, preparation: { defaultTimeoutSeconds: 60  }},
    { previous: [], sensitiveValues: [], store, settings: { mode: "batch", concurrency: 2, lookahead: 2 }, prepareTask: async task => task },
    new AbortController().signal)).rejects.toThrow("Ray batch preparation does not accept lookahead");
});

test("a collected Ray Agent timeout is a valid terminal result without retry", async () => {
  const { store, execute } = await fixture();
  bridge.submit.mockImplementation(async remote => {
    const key = { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId };
    const record = { ...storeRecord(key), executionStatus: "agent_timeout" as const, solve: null, verdict: null,
      errors: [classifyError(new PhaseTimeoutError("solve", "solve time exhausted"), { phase: "solve" })] };
    await store.commit(record, { files: [], missing: [] });
    await store.updateRemoteAttempt!({ key, state: "collected", receipt: "receipt", transferId: "transfer" });
    return { type: "result", attemptId: key.attemptId,
      result: { nodeId: "node", hostname: "host", receipt: { schemaVersion: 1, accepted: true, key, receipt: "receipt", transferId: "transfer", manifestDigest: "a".repeat(64) } } };
  });
  const result = await execute();
  expect(bridge.submit).toHaveBeenCalledTimes(1);
  expect(bridge.cleanupAttempt).not.toHaveBeenCalled();
  expect(result[0]).toMatchObject({ executionStatus: "agent_timeout", });
});


test("Ray keeps auto unresolved for the worker and preserves parallel scores after an architecture failure", async () => {
  const { store, execute } = await fixture(["a", "b"]);
  bridge.submit.mockImplementation(async remote => {
    expect(remote.safeConfig.environment).toEqual({ name: "docker", config: { platform: "auto" } });
    if (remote.job.taskId === "b") return { type: "failed", attemptId: remote.job.attemptId, code: "ENV_ARCH_UNSUPPORTED", retired: true };
    const key = { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId };
    await store.commit(storeRecord(key), { files: [], missing: [] });
    await store.updateRemoteAttempt!({ key, state: "collected", receipt: "receipt", transferId: "transfer" });
    return { type: "result", attemptId: key.attemptId, result: { nodeId: "node", hostname: "host",
      receipt: { schemaVersion: 1, accepted: true, key, receipt: "receipt", transferId: "transfer", manifestDigest: "a".repeat(64) } } };
  });
  const results = await execute();
  expect(bridge.submit).toHaveBeenCalledTimes(2);
  expect(results.find(record => record.key.taskId === "a")).toMatchObject({ executionStatus: "completed", verdict: { score: 1 } });
  expect(results.find(record => record.key.taskId === "b")).toMatchObject({ executionStatus: "failed", verdict: null,
    errors: [expect.objectContaining({ code: "ENV_ARCH_UNSUPPORTED", retryable: false })] });
  expect(await store.listAttempts()).toHaveLength(2);
  expect(computeSuccessRate(await store.snapshot())).toMatchObject({ denominator: 1, invalid: 1, rate: 1 });
});


test("Ray returns structured network evidence only after retirement and cleanup", async () => {
  const { execute } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId, code: "NETWORK_FAILURE", retired: true,
    network: { networkStage: "docker-pull", networkReason: "connection-interrupted", networkEvidence: "ECONNRESET" } }));
  const results = await execute();
  expect(results[0]?.errors[0]).toMatchObject({ code: "NETWORK_FAILURE", details: { networkStage: "docker-pull", networkEvidence: "ECONNRESET" } });
  expect(bridge.cleanupAttempt).toHaveBeenCalledTimes(1);
  expect(bridge.submit).toHaveBeenCalledTimes(1);
});
