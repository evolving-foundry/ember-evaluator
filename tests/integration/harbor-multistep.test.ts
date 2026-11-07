import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import { evaluateHarborSteps } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/steps.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun, fixtureFailure } from "../fixtures/results/store-fixture.js";
import type { PreparedTask } from "../../src/core/contracts/task.js";
import { assertAttemptRecord } from "../../src/core/results/record-validation.js";
import { readTrajectoryPrefix } from "../../src/core/artifacts/trajectory-recovery.js";
import { PhaseTimeoutError } from "../../src/core/policies/phase-timeout.js";
import type { AttemptStepResult } from "../../src/core/contracts/result.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const reference = JSON.parse(await readFile(new URL("../fixtures/harbor-multistep-reference.json", import.meta.url), "utf8")) as {
  cases: { name: string; strategy: string; rewards: (Record<string, number> | null)[];
    threshold: number | Record<string, number> | null; error?: boolean;
    expected: { continue: boolean; rewards: Record<string, number> | null } }[];
};
test.each(reference.cases)("matches pinned official Harbor reward and gate: $name", async value => {
  const { task, config } = await fixture();
  task.verification = { stepRewardStrategy: value.strategy };
  task.steps = value.rewards.map((_, index) => ({ name: `step${index}`, task: task.steps![0]!.task,
    ...(index === value.rewards.length - 1 && value.threshold !== null ? { minReward: value.threshold } : {}) }));
  const results: AttemptStepResult[] = value.rewards.map((rewards, index) => ({ name: `step${index}`, solve: null,
    verdict: rewards === null ? null : { ...(rewards.reward === undefined ? {} : { score: rewards.reward }), passed: false, details: { rewards } },
    errors: index === value.rewards.length - 1 && value.error ? [fixtureFailure("solve", "SOLVER_AGENT_TIMEOUT", "fixture timeout")] : [],
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), evidencePath: `steps/step${index}` }));
  const result = evaluateHarborSteps(task, results, config.scoring);
  expect(result.continue).toBe(value.expected.continue);
  expect(result.verdict === null ? null : (result.verdict.details as { rewards: Record<string, number> }).rewards).toEqual(value.expected.rewards);
});
async function fixture(extra = "") {
  const root = await mkdtemp(join(tmpdir(), "harbor-steps-")); roots.push(root);
  await writeFixture(root, {
    "task.toml": `schema_version="1.3"\n${extra}\n[[steps]]\nname="first"\nmin_reward=0.6\n[steps.agent]\ntimeout_sec=5\n[[steps]]\nname="second"\n[environment]\nworkdir="/app"\n[agent]\ntimeout_sec=10\n[verifier]\nnetwork_mode="no-network"\n`,
    "environment/Dockerfile": "FROM fixture:locked\nWORKDIR /app\n",
    "steps/first/instruction.md": "first public instruction",
    "steps/first/tests/test.sh": "private first verifier",
    "steps/second/instruction.md": "second public instruction",
    "steps/second/tests/test.sh": "private second verifier",
    "steps/second/workdir/payload.bin": "public stage input",
  });
  const config = parseHarborConfig({});
  const task = await loadGenericHarborTask(root, root, "a", config, new HarborShellVerifier(), signal());
  return { root, task, config };
}

test("loads ordered step instructions, verifier roots, inherited timeouts and delayed public files", async () => {
  const { root, task } = await fixture();
  expect(task.steps?.map(step => step.name)).toEqual(["first", "second"]);
  expect(task.steps?.[0]?.task.phaseTimeoutSeconds?.solve).toBe(5);
  expect(task.steps?.[1]?.task.phaseTimeoutSeconds?.solve).toBe(10);
  expect(task.steps?.[1]?.workdirFiles).toBe(join(root, "steps/second/workdir"));
  expect(task.steps?.[0]?.task.verification).toMatchObject({ descriptor: { taskDir: root, stepName: "first" } });
  expect(JSON.stringify(task.steps?.map(step => step.task.input))).not.toMatch(/minReward|private|verifier/);
});

test.each(["../escape", "first"])("rejects unsafe or duplicate step name %s", async name => {
  const { root } = await fixture();
  const text = await readFile(join(root, "task.toml"), "utf8");
  await writeFile(join(root, "task.toml"), text.replace('name="second"', `name="${name}"`));
  await expect(loadGenericHarborTask(root, root, "a", parseHarborConfig({}), new HarborShellVerifier(), signal())).rejects.toThrow(/Step names/);
});

test.each([
  { reward: 0.5, strategy: "mean", count: 1, score: 0.5, failure: "none" },
  { reward: 0.8, strategy: "mean", count: 2, score: 0.9, failure: "none" },
  { reward: 0.8, strategy: "final", count: 2, score: 1, failure: "none" },
  { reward: 0.8, strategy: "mean", count: 2, score: 0.9, failure: "solve-timeout" },
  { reward: 0.8, strategy: "mean", count: 2, score: 0.8, failure: "verify" },
  { reward: 0.8, strategy: "final", count: 2, score: null, failure: "verify" },
])("executes shared steps with threshold/strategy $reward $strategy $failure", async ({ reward, strategy, count, score, failure }) => {
  const { root, config } = await fixture();
  const value = harness(root);
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => {
    const base = await prepare(...args);
    const task: PreparedTask = { ...base, verificationMode: "shared", scoreAfterSolveFailure: true };
    return { ...task, verification: { stepRewardStrategy: strategy }, steps: [
      { name: "first", minReward: 0.6, task: { ...task, input: { id: "a", prompt: "first" } } },
      { name: "second", task: { ...task, input: { id: "a", prompt: "second" } } },
    ] };
  };
  value.components.benchmark.evaluateSteps = (task, results) => evaluateHarborSteps(task, results, config.scoring);
  const environment = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await environment(...args);
    session.transitionToVerification = async () => { value.events.push("to-verify"); };
    session.transitionToSolve = async () => { value.events.push("to-solve"); };
    session.quiesce = async () => { value.events.push("quiesce"); };
    return session;
  };
  let verified = 0;
  const solve = value.components.solver.solve.bind(value.components.solver);
  value.components.solver.solve = async (...args) => {
    const result = await solve(...args);
    if (failure === "solve-timeout" && value.inputs.length === 1) throw new PhaseTimeoutError("solve");
    return result;
  };
  value.components.benchmark.verify = async () => {
    const score = verified++ === 0 ? reward : 1;
    if (failure === "verify" && verified === 2) throw new Error("native verifier failed");
    return { score, passed: score >= 1, details: { rewards: { reward: score } } };
  };
  await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: ["a"] }, {});
  try {
    const record = await runTask({ runId: storeRun.runId, taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" },
      configFingerprint: storeRun.configFingerprint }, value.components, source, signal());
    expect(record.errors).toHaveLength(failure === "none" ? 0 : 1);
    expect(record).toMatchObject({ executionStatus: score === null ? "failed" : "completed", scoreStatus: score === null ? "invalid" : "valid",
      verdict: score === null ? null : { score },
      solve: { usage: { totalTokens: (failure === "solve-timeout" ? count - 1 : count) * 5 } } });
    expect(record.steps).toHaveLength(count);
    expect(value.inputs.map(input => input.prompt)).toEqual(["first", "second"].slice(0, count));
    expect(value.events.filter(event => event === "solve.environment")).toHaveLength(1);
    expect(value.events.filter(event => event === "to-solve")).toHaveLength(count - 1);
    assertAttemptRecord(record);
    const output = join(value.config.experiment.output.directory, record.key.runId, "tasks", createHash("sha256").update("a").digest("hex"), "attempts", "first");
    expect((await readTrajectoryPrefix(output, record.key)).state).toBe("complete");
    expect(await readFile(join(output, "steps/first/agent/session.jsonl"), "utf8")).toContain("fixture");
  } finally { await value.dispose(); }
});
