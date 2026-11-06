import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { executeWarmup, warmupSelectedTasks } from "../../src/application/warmup.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import { harness } from "../fixtures/engine/fakes.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__warmupEvent;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(mode: "batch" | "pipeline" = "pipeline", budget = 10) {
  const root = await mkdtemp(join(tmpdir(), "warmup-"));
  const value = harness(root, { transfer: true });
  cleanups.push(async () => { await value.components.dispose(); await rm(root, { recursive: true, force: true }); });
  const { components, config } = value;
  config.experiment.run.preparation = { mode, concurrency: 2, ...(mode === "pipeline" ? { lookahead: 2 } : {}) };
  components.benchmark.planRun = (refs, source, signal) =>
    planBenchmarkRun(components.benchmark, refs, source, signal, { version: "test", source: "fixture" }, budget);
  components.environment.materialize = async spec => spec;
  const forbidden = [vi.spyOn(components.solver, "solve"), vi.spyOn(components.environment, "prepare"),
    vi.spyOn(components.benchmark, "verify"),
    vi.spyOn(components.scheduler, "executeReady"), vi.spyOn(components.store, "create"),
    vi.spyOn(components.store, "allocate"), vi.spyOn(components.store, "updateRun"), vi.spyOn(components.reporter, "render")];
  return { ...value, root, forbidden };
}

test.each(["batch", "pipeline"] as const)("%s prepares solve, verify, solver installation and verifier runtime without running an evaluation", async mode => {
  const { components, config, forbidden } = await fixture(mode);
  const installation = { id: "fixture-installation", files: [], commands: [], probes: [] };
  components.solver.runtimeInstallation = vi.fn(async () => installation);
  components.environment.supportsRuntimeInstallation = true;
  const specs: { spec: EnvironmentSpec; phase: string | undefined }[] = [];
  components.environment.materialize = async (spec, _signal, _ready, _activity, context) => {
    specs.push({ spec, phase: context?.phase }); return spec;
  };
  const materializeVerifier = vi.fn(async () => ({ image: "verifier:ready" }));
  const prepareVerifier = vi.fn(async (): Promise<never> => { throw new Error("must not run"); });
  components.benchmark = { ...components.benchmark, verificationRuntime: { materialize: materializeVerifier, prepare: prepareVerifier } };
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result).toMatchObject({ status: "ready", taskIds: ["a", "b", "c"], readyTaskIds: ["a", "b", "c"], failures: [],
    preparationRounds: [{ status: "ready" }] });
  expect(components.solver.runtimeInstallation).toHaveBeenCalledTimes(1);
  expect(specs.filter(item => item.phase === "solve").map(item => item.spec)).toEqual(Array.from({ length: 3 }, () =>
    expect.objectContaining({ runtime: [{ name: "node", version: "24", platform: "any" }], installation })));
  expect(specs.filter(item => item.phase === "verify").every(item => item.spec.runtime.length === 0 && !item.spec.installation)).toBe(true);
  expect(materializeVerifier).toHaveBeenCalledTimes(3);
  expect(prepareVerifier).not.toHaveBeenCalled();
  for (const call of forbidden) expect(call).not.toHaveBeenCalled();
});

test("warmup uses YAML task IDs and offset", async () => {
  const { components, config } = await fixture();
  config.experiment.run.taskIds = ["b", "c"];
  config.experiment.run.offset = 1;
  const materialize = vi.spyOn(components.environment, "materialize");
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result.readyTaskIds).toEqual(["c"]);
  expect(materialize).toHaveBeenCalledTimes(2);
});

test.each(["batch", "pipeline"] as const)("%s reports partial preparation failures and preserves successful images", async mode => {
  const { components, config } = await fixture(mode);
  config.experiment.run.onError = "continue";
  components.environment.materialize = async (spec, _signal, _ready, _activity, context) => {
    if (context?.taskId === "b") throw new Error("failed secret-token");
    return spec;
  };
  const result = await warmupSelectedTasks(components, config, new AbortController().signal, undefined, ["secret-token"]);
  expect(result).toMatchObject({ status: "error", readyTaskIds: ["a", "c"], failures: [{ taskId: "b" }] });
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

test.each(["abort", "continue"] as const)("metadata failures follow onError=%s before image preparation", async onError => {
  const { components, config } = await fixture();
  config.experiment.run.onError = onError;
  const prepare = components.benchmark.prepare.bind(components.benchmark);
  components.benchmark.prepare = async (...args) => {
    if (args[0].id === "b") throw new EvaluatorError("TASK_DATA_INVALID", "Invalid task metadata");
    return prepare(...args);
  };
  const result = await warmupSelectedTasks(components, config, new AbortController().signal);
  expect(result.status).toBe("error");
  expect(result.failures.map(item => item.taskId)).toEqual(["b"]);
  expect(result.readyTaskIds).toEqual(onError === "continue" ? ["a", "c"] : []);
});

test.each(["batch", "pipeline"] as const)("%s stops and drains preparation on cancellation", async mode => {
  const { components, config, forbidden } = await fixture(mode);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  let active = 0;
  components.environment.materialize = async (_spec, signal) => {
    active++; entered.resolve();
    try {
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    } finally { active--; }
  };
  const running = warmupSelectedTasks(components, config, controller.signal);
  const failed = expect(running).rejects.toThrow("cancel warmup");
  await entered.promise;
  controller.abort(new Error("cancel warmup"));
  await failed;
  expect(active).toBe(0);
  for (const call of forbidden) expect(call).not.toHaveBeenCalled();
});

test.each(["batch", "pipeline"] as const)("%s enforces each environment preparation timeout", async mode => {
  const { components, config } = await fixture(mode, 0.05);
  components.environment.materialize = async (_spec, signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toMatchObject({ code: "ENV_PREPARATION_TIMEOUT" });
});

test.each(["batch", "pipeline"] as const)("%s enforces an explicit round deadline independently of environment bases", async mode => {
  const { components, config } = await fixture(mode, 20);
  config.experiment.run.preparation = { mode, concurrency: 2, roundTimeoutSeconds: 0.05 };
  components.environment.materialize = async (_spec, signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toThrow(/deadline/i);
});

test("remote schedulers without preparation initialization are rejected before downloading sources", async () => {
  const { components, config, events } = await fixture();
  components.scheduler = { executionLocation: "remote", executeReady: components.scheduler.executeReady };
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toThrow(/setupPreparation/);
  expect(events).toEqual([]);
});

test("plugins without preparation capabilities fail before resolving sources", async () => {
  const { components, config, events } = await fixture();
  delete components.environment.materialize;
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toThrow(/materialize/);
  expect(events).toEqual([]);
});

test("a mismatched benchmark plan cannot prepare unselected tasks", async () => {
  const { components, config } = await fixture();
  const planRun = components.benchmark.planRun!;
  components.benchmark.planRun = async (...args) => {
    const plan = await planRun(...args);
    plan.tasks.reverse();
    return plan;
  };
  const materialize = vi.spyOn(components.environment, "materialize");
  await expect(warmupSelectedTasks(components, config, new AbortController().signal)).rejects.toThrow(/differs/);
  expect(materialize).not.toHaveBeenCalled();
});

async function cliFixture() {
  const root = await mkdtemp(join(tmpdir(), "cli-warmup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "experiment.yaml"), patch = join(root, "patch.yaml");
  const experiment = {
    services: { default: { model: "unused-model", base_url: "http://model.invalid", api_key: "${WARMUP_MISSING_KEY}" } },
    benchmark: { name: "warmup-fixture", config: {}, solver: { name: "warmup-fixture", service: "default", config: {} } },
    environment: { name: "warmup-fixture", config: {} }, scheduler: { name: "local", config: { concurrency: 2 } },
    run: { maxTasks: 1 }, output: { directory: join(root, "results") },
  };
  await writeFile(file, JSON.stringify(experiment));
  await writeFile(patch, JSON.stringify([{ insert: [{ id: "warmup-fixture", name: join(import.meta.dirname, "../fixtures/warmup/plugin.mjs") }] }]));
  const events: { name: string; value: unknown }[] = [];
  (globalThis as Record<string, unknown>).__warmupEvent = (name: string, value: unknown) => { events.push({ name, value }); };
  const stdout: string[] = [], stderr: string[] = [];
  const io = { out: (text: string) => { stdout.push(text); }, error: (text: string) => { stderr.push(text); } };
  vi.stubEnv("WARMUP_MISSING_KEY", "");
  return { root, file, patch, experiment, events, stdout, stderr, io };
}

test("standalone warmup loads a patch without API keys, honors task ID overrides and leaves no run directory", async () => {
  const { root, file, patch, events, stdout, stderr, io } = await cliFixture();
  const ids = join(root, "ids.json"); await writeFile(ids, JSON.stringify({ taskIds: ["b", "c"] }));
  expect(await runCli(["warmup", file, "--patch", patch, "--task-ids-file", ids, "--progress", "plain"], io), stderr.join("\n")).toBe(0);
  expect(stdout).toEqual(["Image warmup: 2/2 tasks ready; 0 failed"]);
  expect(events.filter(item => item.name === "materialize").map(item => item.value).sort()).toEqual(["b", "c"]);
  expect(events.at(-1)?.name).toBe("dispose");
  expect(stderr.join("\n")).not.toMatch(/entering the solve queue|ERROR/);
  await expect(access(join(root, "results"))).rejects.toThrow();
});

test("CLI returns 1 for partial warmup and redacts source credentials from its summary", async () => {
  const { file, patch, experiment, stdout, stderr, io } = await cliFixture();
  vi.stubEnv("WARMUP_TEST_TOKEN", "fixture-private-token");
  await writeFile(file, JSON.stringify({ ...experiment, run: { onError: "continue" },
    environment: { name: "warmup-fixture", config: { failTask: "b" } } }));
  expect(await runCli(["warmup", file, "--patch", patch], io)).toBe(1);
  expect(stdout[0]).toBe("Image warmup: 2/3 tasks ready; 1 failed");
  expect(stdout).toHaveLength(2);
  expect(stdout[1]).toMatch(/^b: .*Fixture preparation failed/);
  expect(stdout.join("\n")).not.toMatch(/preparationRounds|durationMs|readyTaskIds/);
  expect([...stdout, ...stderr].join("\n")).not.toContain("fixture-private-token");
});

test("observer failure cancels image preparation and still releases plugins", async () => {
  const { file, patch, events } = await cliFixture();
  await expect(executeWarmup({ configPath: file, patchPath: patch, signal: new AbortController().signal,
    onProgress(event) { if (event.phase === "prepare") throw new Error("observer failed"); } })).rejects.toThrow("observer failed");
  expect(events.at(-1)?.name).toBe("dispose");
});

test("CLI cancellation returns 130 and releases plugins without creating a run", async () => {
  const { root, file, patch, events, io } = await cliFixture();
  const controller = new AbortController();
  (globalThis as Record<string, unknown>).__warmupEvent = (name: string, value: unknown) => {
    events.push({ name, value });
    if (name === "materialize") controller.abort(new DOMException("cancelled", "AbortError"));
  };
  expect(await runCli(["warmup", file, "--patch", patch], io, controller.signal)).toBe(130);
  expect(events.at(-1)?.name).toBe("dispose");
  await expect(access(join(root, "results"))).rejects.toThrow();
});

test.each([["warmup"], ["warmup", "x", "--resume"], ["warmup", "x", "--dry-run"], ["warmup", "x", "--unknown"]])(
  "invalid warmup command %j returns 2", async (...argv) => {
    const errors: string[] = [];
    expect(await runCli(argv, { out() {}, error(text) { errors.push(text); } })).toBe(2);
    expect(errors.length).toBeGreaterThan(0);
  });
