import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import type { PhaseTimeoutOverrides } from "../../src/core/contracts/task.js";
import { loadConfig } from "../../src/application/config.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { createBenchmark } from "../../src/application/plugins/create-components.js";
import { setTimeout as delay } from "node:timers/promises";
import { runTask } from "../../src/core/execution/run-task.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun } from "../fixtures/results/store-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(solve?: number, verify?: number) {
  const root = await mkdtemp(join(tmpdir(), "harbor-phase-timeouts-")); roots.push(root);
  const task = join(root, "dataset/tasks/task");
  await writeFixture(task, { "instruction.md": "Solve the task.\n", "tests/test.sh": "true\n",
    "task.toml": `[task]\nname="task"\n[environment]\ndocker_image="fixture/task:latest"\nworkdir="/task"\n[agent]\n${solve === undefined ? "" : `timeout_sec=${solve}`}\n[verifier]\n${verify === undefined ? "" : `timeout_sec=${verify}`}\n` });
  return { root, task };
}

test.each([
  { label: "task declarations", overrides: {}, solve: 11, verify: 13 },
  { label: "longer YAML ceilings", overrides: { solveTimeoutSeconds: 110, verifyTimeoutSeconds: 130 }, solve: 110, verify: 130 },
  { label: "shorter YAML ceilings", overrides: { solveTimeoutSeconds: 1, verifyTimeoutSeconds: 2 }, solve: 1, verify: 2 },
  { label: "solve-only override", overrides: { solveTimeoutSeconds: 21 }, solve: 21, verify: 13 },
  { label: "verify-only override", overrides: { verifyTimeoutSeconds: 23 }, solve: 11, verify: 23 },
])("Harbor resolves $label consistently in phase limits and verifier descriptors", async ({ overrides, solve, verify }) => {
  const { task } = await fixture(11, 13);
  const result = await loadGenericHarborTask(task, task, "task", parseHarborConfig({ defaults: { workdir: "/yaml" } }),
    new HarborShellVerifier(), AbortSignal.timeout(5000), overrides as PhaseTimeoutOverrides);
  expect(result.phaseTimeoutSeconds).toMatchObject({ solve, verify });
  expect(result.verification).toHaveProperty("descriptor.timeoutSeconds", verify);
  expect(result.solveEnv.workdir).toBe("/task");
});

test("omitted task and YAML ceilings do not inject a verifier or solve timeout", async () => {
  const { task } = await fixture();
  const result = await loadGenericHarborTask(task, task, "task", parseHarborConfig({}), new HarborShellVerifier(), AbortSignal.timeout(5000));
  expect(result.phaseTimeoutSeconds).not.toHaveProperty("solve");
  expect(result.phaseTimeoutSeconds).not.toHaveProperty("verify");
  expect(result.verification).not.toHaveProperty("descriptor.timeoutSeconds");
});

test("removed Harbor verify default is rejected instead of silently overriding new semantics", () => {
  expect(() => parseHarborConfig({ defaults: { verifyTimeoutSeconds: 300 } })).toThrow("verifyTimeoutSeconds");
});

test("YAML run overrides reach the actual Harbor component through bootstrap", async () => {
  const { root } = await fixture(11, 13);
  const file = join(root, "experiment.yaml");
  await writeFile(file, JSON.stringify({ services: { default: { model: "fixture", base_url: "http://127.0.0.1:1" } },
    benchmark: { name: "harbor", config: { source: { kind: "local", path: "./dataset" }, cacheDir: "./cache", tasks: { root: "tasks", id: "directory" } } },
    run: { solveTimeoutSeconds: 23, verifyTimeoutSeconds: 29 } }));
  const config = await loadConfig(file, {}, {}, { allowMissingAuth: true });
  const registry = await openPluginRegistry();
  try {
    const benchmark = await createBenchmark(registry, config, root);
    const signal = AbortSignal.timeout(5000), source = await benchmark.resolveSource(null, signal);
    const refs = [];
    for await (const ref of benchmark.enumerate(source, signal)) refs.push(ref);
    expect(refs).toHaveLength(1);
    const task = await benchmark.prepare(refs[0]!, source, signal);
    expect(task.phaseTimeoutSeconds).toMatchObject({ solve: 23, verify: 29 });
    expect(task.verification).toHaveProperty("descriptor.timeoutSeconds", 29);
  } finally { await registry.dispose(); }
});

test("a longer YAML verification ceiling also replaces the Shell verifier's internal task deadline", async () => {
  const { root, task: path } = await fixture(undefined, 0.01);
  const shell = new HarborShellVerifier();
  const task = await loadGenericHarborTask(path, path, "a", parseHarborConfig({}), shell, AbortSignal.timeout(5000), { verifyTimeoutSeconds: 1 });
  const value = harness(root);
  value.components.benchmark.prepare = async () => task;
  value.components.benchmark.verify = async (prepared, _solve, session, signal) => {
    if (!session) throw new Error("Missing grading session");
    const evidence = await shell.verify(prepared.verification, session, signal);
    return { score: evidence.rewards.reward!, passed: evidence.rewards.reward === 1, details: evidence.details };
  };
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    session.transitionToVerification = async () => {};
    session.upload = async () => {};
    session.start = async (command, signal) => ({
      stdout: (async function* () { if (command.args[1]?.includes("fmt=json")) yield Buffer.from("txt\n1\n"); })(), stderr: (async function* () {})(), async stop() {},
      done: (async () => { await delay(70, undefined, { signal }); await writeFile(join(session.verifierOutputDir, "reward.txt"), "1\n"); return { code: 0, signal: null }; })(),
    });
    return session;
  };
  try {
    await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: ["a"] }, {});
    const result = await runTask({ runId: storeRun.runId, taskId: "a", attemptId: "yaml-grading-override", ref: { id: "a", recordKey: "a" }, configFingerprint: storeRun.configFingerprint },
      value.components, source, new AbortController().signal, { timeoutSeconds: 2, verifyTimeoutSeconds: 1 });
    expect(result.executionStatus, JSON.stringify(result.errors)).toBe("completed");
    expect(result.verdict?.score).toBe(1);
  } finally { await value.dispose(); }
});
