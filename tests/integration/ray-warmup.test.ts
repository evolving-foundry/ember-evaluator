import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RayScheduler } from "../../src/plugins/schedulers/ray/scheduler.js";
import { warmupSelectedTasks } from "../../src/application/warmup.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import type { RayResult } from "../../src/infrastructure/ray/client.js";
import type { RemoteJob } from "../../src/infrastructure/ray/protocol.js";
import type { ReceiverServerOptions } from "../../src/infrastructure/transfer/https.js";
import { harness } from "../fixtures/engine/fakes.js";
import { assertJsonValue } from "../../src/core/validation/input.js";
import { storeRun } from "../fixtures/results/store-fixture.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";

const digest = `sha256:${"a".repeat(64)}`;
const bridge = vi.hoisted(() => ({ submit: vi.fn<(job: RemoteJob) => Promise<RayResult>>(), cancel: vi.fn(),
  close: vi.fn(async () => {}), server: vi.fn<(options: ReceiverServerOptions) => void>(),
  env: {} as Record<string, string | undefined>,
  nodes: ["node-b", "node-a"], nodeSlots: { "node-a": 1, "node-b": 1 } as Record<string, number> }));
vi.mock("../../src/infrastructure/ray/client.js", () => ({ RayClient: class {
  constructor(options: { env: Record<string, string | undefined> }) { bridge.env = options.env; }
  nodes = bridge.nodes; nodeSlots = bridge.nodeSlots;
  slots = Object.values(bridge.nodeSlots).reduce((a, b) => a + b, 0);
  start = async () => {};
  submit = bridge.submit; cancel = bridge.cancel; close = bridge.close;
} }));
vi.mock("../../src/infrastructure/provenance/package.js", () => ({ PACKAGE_RUNTIME_ID: "ember-evaluator:package", loadPackageDigest: async () => `sha256:${"a".repeat(64)}` }));
vi.mock("../../src/infrastructure/transfer/https.js", () => ({ startTransferReceiver: async (options: ReceiverServerOptions) => {
  bridge.server(options); return { url: "https://collector.invalid", close: async () => {} };
} }));

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("WARMUP_RAY_TOKEN", "fixture-transfer-token");
  bridge.cancel.mockReset();
  bridge.nodes = ["node-b", "node-a"]; bridge.nodeSlots = { "node-a": 1, "node-b": 1 };
  bridge.submit.mockImplementation(async remote => ({ type: "prepared", attemptId: remote.job.attemptId,
    result: { nodeId: remote.preparation!.nodeId, hostname: "fixture", preparationDigest: "b".repeat(64) } }));
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

async function fixture(count = 6) {
  const root = await mkdtemp(join(tmpdir(), "ray-warmup-"));
  const value = harness(root);
  const { components, config } = value;
  const cert = join(root, "certificate.pem"); await writeFile(cert, "fixture");
  const scheduler = new RayScheduler({ endpoint: "local", pythonExecutable: "unused", startupTimeoutMs: 1000,
    heartbeatTimeoutMs: 1000, cancelGraceMs: 1000, collector: { certFile: cert, keyFile: cert,
      tokenEnv: "WARMUP_RAY_TOKEN", host: "127.0.0.1", port: 0 } },
  { configDirectory: root, solverService: "default", resolvePath: path => path,
    services: { default: { model: { name: "fixture", endpoint: null, provider: null, api: "openai-completions" },
      auth: { value: "", reference: "WARMUP_MODEL_API_KEY" } } } });
  components.scheduler = scheduler;
  components.pluginVersions = { "ember-evaluator:package": digest };
  config.auths.default = { value: "", reference: null };
  components.benchmark.enumerate = async function* () { for (let i = 0; i < count; i++) yield { id: `t${i}`, recordKey: i }; };
  components.benchmark.planRun = (refs, source, signal) =>
    planBenchmarkRun(components.benchmark, refs, source, signal, { source: "fixture", version: "1" }, 10);
  config.experiment.run.preparation = { mode: "batch", concurrency: 1 };
  assertJsonValue(config.experiment); config.persisted = structuredClone(config.experiment);
  cleanups.push(async () => { await scheduler.close(); await value.dispose(); await rm(root, { recursive: true, force: true }); });
  return { ...value, scheduler };
}

test("six warmup tasks go to exactly one of two nodes; coordinator never prepares images or creates evaluation records", async () => {
  const { components, config } = await fixture();
  vi.stubEnv("WARMUP_MODEL_API_KEY", "unused-private-model-key");
  const create = vi.spyOn(components.store, "create"), allocate = vi.spyOn(components.store, "allocate");
  const solve = vi.spyOn(components.solver, "solve"), verify = vi.spyOn(components.benchmark, "verify");
  const execute = vi.spyOn(components.scheduler, "executeReady");
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result.status).toBe("ready"); expect(result.readyTaskIds).toHaveLength(6);
  expect(result.placements.filter(item => item.nodeId === "node-a").map(item => item.taskId)).toEqual(["t0", "t2", "t4"]);
  expect(result.placements.filter(item => item.nodeId === "node-b").map(item => item.taskId)).toEqual(["t1", "t3", "t5"]);
  expect(bridge.submit).toHaveBeenCalledTimes(6);
  expect(new Set(bridge.submit.mock.calls.map(([remote]) => remote.job.taskId)).size).toBe(6);
  expect(bridge.server.mock.calls[0]?.[0].receiver).toBeUndefined();
  expect(bridge.env.WARMUP_MODEL_API_KEY).toBeUndefined();
  for (const call of [create, allocate, solve, verify, execute]) expect(call).not.toHaveBeenCalled();
});

test("capacity weighting and node ordering are the same for warmup and formal preparation", async () => {
  bridge.nodeSlots = { "node-a": 1, "node-b": 2 };
  const first = await fixture();
  first.config.experiment.run.preparation = { mode: "batch", concurrency: 2 };
  const warmed = await warmupSelectedTasks(first.components, first.config, new AbortController().signal);
  expect(warmed.placements.filter(item => item.nodeId === "node-b")).toHaveLength(4);
  bridge.nodes = ["node-a", "node-b"];
  const second = await fixture();
  const { components, config, scheduler } = second;
  const source = await components.benchmark.resolveSource(null, new AbortController().signal);
  const run = { ...storeRun, source, configFingerprint: fingerprintConfig(config.persisted), pluginVersions: components.pluginVersions };
  vi.spyOn(components.store, "listAttempts").mockResolvedValue([]);
  await scheduler.setup({ run, safeConfig: config.persisted, store: components.store }, new AbortController().signal);
  const refs = []; for await (const ref of components.benchmark.enumerate(source, new AbortController().signal)) refs.push(ref);
  const plan = await components.benchmark.planRun!(refs, source, new AbortController().signal);
  const prepared = await scheduler.prepareTasks(refs.map(ref => ({ runId: run.runId, taskId: ref.id, ref,
    attemptId: `attempt-${ref.id}`, configFingerprint: run.configFingerprint })), plan, {
    previous: [], sensitiveValues: [], store: { async updateRun() {} }, prepareTask: async () => { throw new Error("coordinator preparation is forbidden"); },
  }, new AbortController().signal);
  expect(prepared.placements).toEqual(warmed.placements);
  for (const [remote] of bridge.submit.mock.calls) {
    expect(remote.preparation?.deadlineAt).toBeNull();
    expect(remote.preparation?.concurrency).toBe(remote.preparation?.nodeId === "node-a" ? 1 : 2);
  }
});

test("nodes with no assigned task receive no preparation request", async () => {
  const { components, config } = await fixture(1);
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result.placements).toEqual([{ taskId: "t0", nodeId: "node-a" }]);
  expect(bridge.submit).toHaveBeenCalledTimes(1);
});

test("a failed task keeps its placement and cannot be counted as ready or moved to another node", async () => {
  const { components, config } = await fixture();
  config.experiment.run.onError = "continue";
  bridge.submit.mockImplementation(async remote => remote.job.taskId === "t1"
    ? { type: "failed", attemptId: remote.job.attemptId, code: "ENV_PREPARATION_FAILED", retired: true, originalName: "Error" }
    : { type: "prepared", attemptId: remote.job.attemptId, result: { nodeId: remote.preparation!.nodeId, hostname: "host", preparationDigest: "b".repeat(64) } });
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result).toMatchObject({ status: "error", failures: [{ taskId: "t1" }] });
  expect(result.readyTaskIds).not.toContain("t1");
  expect(result.placements.find(item => item.taskId === "t1")).toEqual({ taskId: "t1", nodeId: "node-b" });
  expect(bridge.submit.mock.calls.filter(([job]) => job.job.taskId === "t1")).toHaveLength(1);
});

test("unconfirmed remote retirement stops the preparation round", async () => {
  const { components, config } = await fixture();
  bridge.submit.mockImplementation(async remote => ({ type: "failed", attemptId: remote.job.attemptId,
    code: "RAY_WORKER_LOST", retired: false }));
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toThrow(/retirement is unconfirmed/);
});

test.each(["cancel", "deadline"] as const)("remote warmup %s drains active preparations and leaves later jobs unstarted", async mode => {
  const { components, config } = await fixture();
  if (mode === "deadline") {
    config.experiment.run.preparation = { mode: "batch", concurrency: 1, roundTimeoutSeconds: 0.1 };
  }
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = new Map<string, (result: RayResult) => void>();
  bridge.submit.mockImplementation(remote => new Promise(resolve => {
    pending.set(remote.job.attemptId, resolve);
    if (pending.size === 2) entered.resolve();
  }));
  bridge.cancel.mockImplementation((attemptId: string) => {
    pending.get(attemptId)?.({ type: "failed", attemptId, retired: true, code: "RAY_WORKER_LOST" });
    pending.delete(attemptId);
  });
  const running = warmupSelectedTasks(components, config, controller.signal);
  const rejected = expect(running).rejects.toThrow(mode === "cancel" ? /cancel warmup/ : /deadline/);
  await entered.promise;
  if (mode === "cancel") controller.abort(new Error("cancel warmup"));
  await rejected;
  expect(pending.size).toBe(0);
  expect(bridge.submit).toHaveBeenCalledTimes(2);
});
