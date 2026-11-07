import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runTask, type RunTaskOptions } from "../../src/core/execution/run-task.js";
import { onDemand } from "../../src/core/preparation/task-preparation.js";
import type { ProcessHandle } from "../../src/core/contracts/environment.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { storeRun } from "../fixtures/results/store-fixture.js";

const fixtures: { root: string; value: ReturnType<typeof harness> }[] = [];
afterEach(async () => { for (const { root, value } of fixtures.splice(0)) { await value.dispose(); await rm(root, { recursive: true, force: true }); } });
async function setup(shared: boolean, hookCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "harbor-lifecycle-")); const value = harness(root, { transfer: !shared }); fixtures.push({ root, value });
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), verificationMode: shared ? "shared" : "separate",
    collect: [{ executable: "bash", args: ["-c", "collect"], cwd: ".", env: {}, timeoutSeconds: 1 }] });
  const environment = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await environment(...args);
    session.transitionToVerification = async () => { value.events.push("transition"); };
    session.quiesce = async () => { value.events.push("quiesce"); };
    session.start = async (): Promise<ProcessHandle> => { value.events.push("hook"); return { stdout: (async function* () {})(), stderr: (async function* () {})(), done: Promise.resolve({ code: hookCode, signal: null }), async stop() {} }; };
    return session;
  };
  value.components.benchmark.verify = async (_task, _solve, session) => { value.events.push("verify"); expect(session?.id).toBe(shared ? "solve-id" : "verify-id"); return { score: 1, passed: true, details: {} }; };
  await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: ["a"] }, {});
  const run = (options: RunTaskOptions = {}) => runTask(onDemand({ runId: storeRun.runId, taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" }, configFingerprint: storeRun.configFingerprint }), value.components, source, new AbortController().signal, options);
  return { ...value, run };
}

test("shared verification retains one environment and orders collect before private verification", async () => {
  const value = await setup(true); const record = await value.run();
  expect(record.executionStatus).toBe("completed");
  expect(value.events.filter(event => ["solve", "transition", "hook", "verify", "solve.cleanup"].includes(event))).toEqual(["solve", "transition", "hook", "verify", "solve.cleanup"]);
  expect(value.events).not.toContain("verify.environment"); expect(value.events).not.toContain("export");
  expect(JSON.stringify(value.inputs)).not.toContain("private-solution");
});

test("separate verification collects, exports and disposes the solver environment before restore", async () => {
  const value = await setup(false); expect((await value.run()).executionStatus).toBe("completed");
  const relevant = value.events.filter(event => ["hook", "export", "solve.cleanup", "verify.environment", "restore", "verify"].includes(event));
  expect(relevant).toEqual(["hook", "export", "solve.cleanup", "verify.environment", "restore", "verify"]);
});

test("separate verification without declared artifacts prepares grading without export or restore", async () => {
  const value = await setup(false);
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), transfer: null });
  const record = await value.run();
  expect(record).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 }, collection: { artifacts: "not-produced" } });
  expect(value.events.filter(event => ["hook", "solve.cleanup", "verify.environment", "verify"].includes(event)))
    .toEqual(["hook", "solve.cleanup", "verify.environment", "verify"]);
  expect(value.events).not.toContain("export"); expect(value.events).not.toContain("restore");
  expect(record.warnings ?? []).toEqual([]);
});

test("unconfigured collection keeps a shared-workspace submission readable and preserves grading evidence", async () => {
  const value = await setup(true);
  const solve = value.components.solver.solve.bind(value.components.solver);
  value.components.solver.solve = async (input, session, context) => {
    const result = await solve(input, session, context);
    await writeFile(join(session.workdir, "result.md"), "delivered answer");
    return result;
  };
  let verifierOutput = "";
  value.components.benchmark.verify = async (_task, _result, session) => {
    if (!session) throw new Error("Missing shared grading environment");
    expect(await readFile(join(session.workdir, "result.md"), "utf8")).toBe("delivered answer");
    verifierOutput = join(session.verifierOutputDir, "score.json");
    await writeFile(verifierOutput, '{"reward":1}\n');
    return { score: 1, passed: true, details: {} };
  };
  const record = await value.run();
  expect(record).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", collection: { trajectory: "complete", artifacts: "not-produced" } });
  expect(record.warnings ?? []).toEqual([]);
  expect(value.events).not.toContain("export");
  expect(await readFile(verifierOutput, "utf8")).toContain('"reward":1');
});

test("solver failure still runs declared collect hooks when artifact collection is disabled", async () => {
  const value = await setup(true);
  const solve = value.components.solver.solve.bind(value.components.solver);
  value.components.solver.solve = async (...args) => { await solve(...args); throw new Error("solver failed"); };
  const record = await value.run();
  expect(record.executionStatus).toBe("failed");
  expect(value.events.filter(event => event === "hook")).toHaveLength(1);
  expect(value.events).not.toContain("export");
  expect(value.events).toContain("solve.cleanup");
});

test("collect failure is an invalid attempt, preserves evidence and never verifies", async () => {
  const value = await setup(false, 4); const record = await value.run();
  expect(record.executionStatus).toBe("failed"); expect(record.verdict).toBeNull();
  expect(value.events.filter(event => event === "hook")).toHaveLength(1);
  expect(value.events).toContain("export"); expect(value.events).toContain("solve.cleanup");
});

test("a solver failure still executes collect once and exports partial evidence", async () => {
  const value = await setup(false);
  const solve = value.components.solver.solve.bind(value.components.solver);
  value.components.solver.solve = async (...args) => { await solve(...args); throw new Error("solver failed"); };
  const record = await value.run();
  expect(record).toMatchObject({ executionStatus: "failed", verdict: null, collection: { artifacts: "complete" } });
  expect(value.events.filter(event => ["hook", "export", "solve.cleanup", "commit"].includes(event)))
    .toEqual(["hook", "export", "solve.cleanup", "commit"]);
});

test.each(["hook", "transition", "quiesce"] as const)("a timeout preserves its score and exports only after quiescence when %s fails", async failure => {
  const value = await setup(false, failure === "hook" ? 4 : 0);
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args);
    if (failure === "transition") session.transitionToVerification = async () => { value.events.push("transition"); throw new Error("transition failed"); };
    if (failure === "quiesce") session.quiesce = async () => { value.events.push("quiesce"); throw new Error("quiesce failed"); };
    return session;
  };
  value.components.solver.solve = async (_input, _session, context) => {
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    throw new Error("unreachable");
  };
  const record = await value.run({ solveTimeoutSeconds: 0.05 });
  expect(record).toMatchObject({ executionStatus: "agent_timeout", scoreStatus: "valid", verdict: null, cleanupStatus: "cleaned" });
  expect(record.errors[0]?.code).toBe("SOLVER_AGENT_TIMEOUT");
  expect(record.errors.some(error => error.phase === "collect")).toBe(true);
  expect(value.events).not.toContain("verify");
  expect(value.events).toContain("solve.cleanup");
  if (failure === "quiesce") {
    expect(value.events).not.toContain("export");
    expect(record.collection.artifacts).toBe("missing");
  } else {
    expect(value.events.filter(event => ["transition", "hook", "quiesce", "export"].includes(event)))
      .toEqual(failure === "hook" ? ["transition", "hook", "quiesce", "export"] : ["transition", "quiesce", "export"]);
    expect(record.collection.artifacts).toBe("complete");
  }
});


test("shared verification snapshots declared deliverables before grading without restoring state", async () => {
  const value = await setup(true);
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => ({ ...await prepare(...args), artifactCollection: { kind: "artifacts", workdir: "/workspace", paths: ["/workspace/deliverables"] } });
  const record = await value.run();
  expect(record.executionStatus).toBe("completed");
  expect(value.events.filter(event => ["hook", "export", "verify"].includes(event))).toEqual(["hook", "export", "verify"]);
  expect(value.events).not.toContain("restore"); expect(record.collection.artifacts).toBe("complete");
});
