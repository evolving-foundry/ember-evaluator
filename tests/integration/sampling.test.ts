import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../../src/application/config.js";
import { runEngine } from "../../src/application/run-engine.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { harness } from "../fixtures/engine/fakes.js";

const roots: string[] = [];
const fixtures: ReturnType<typeof harness>[] = [];
const ids = Array.from({ length: 20 }, (_, index) => `task-${index}`);

afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(run: Record<string, unknown> = {}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "evaluator-sampling-"));
  if (!existingRoot) roots.push(root);
  const path = join(root, "experiment.yaml");
  await writeFile(path, stringify({
    services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${FIXTURE_KEY}" } },
    benchmark: { name: "gsm8k", solver: { name: "simpleagent", service: "default" } }, environment: { name: "local" },
    run: { onError: "abort", ...run }, output: { directory: "./runs" },
  }));
  const config = await loadConfig(path, {}, { FIXTURE_KEY: "fixture-key" });
  const value = harness(root);
  fixtures.push(value);
  value.components.benchmark.enumerate = async function* () {
    for (const id of ids) yield { id, recordKey: id };
  };
  value.components.scheduler = new LocalScheduler(1);
  return { ...value, config, root };
}

const random = (seed = 42) => ({ strategy: "random", seed });
const execute = (value: Awaited<ReturnType<typeof fixture>>) =>
  runEngine({ ...value, signal: new AbortController().signal });

test("omitting sampling preserves source order and the existing saved run config", async () => {
  const value = await fixture({ maxTasks: 3 });
  expect(value.config.experiment.run).toEqual({ maxTasks: 3, taskIds: null, timeoutSeconds: 7200, onError: "abort" });
  expect((await execute(value)).run.taskIds).toEqual(["task-0", "task-1", "task-2"]);
});

test("offset and maxTasks run the requested source range and save offset", async () => {
  const value = await fixture({ offset: 10, maxTasks: 5 });
  const snapshot = await execute(value);
  expect(snapshot.run.taskIds).toEqual(ids.slice(10, 15));
  expect(value.inputs.map(input => input.id)).toEqual(ids.slice(10, 15));
  const stored = JSON.parse(await readFile(join(value.root, "runs", snapshot.run.runId, "manifest.json"), "utf8"));
  expect(stored.configSummary.run.offset).toBe(10);
  expect(value.config.persisted).toMatchObject({ run: { offset: 10, maxTasks: 5 } });
});

test.each([
  { offset: 0, maxTasks: 2, expected: ids.slice(0, 2) },
  { offset: 17, expected: ids.slice(17) },
  { offset: 17, maxTasks: null, expected: ids.slice(17) },
  { offset: 19, maxTasks: 5, expected: ids.slice(19) },
])("offset $offset with maxTasks $maxTasks respects available tasks", async ({ expected, ...run }) => {
  const value = await fixture(run);
  expect((await execute(value)).run.taskIds).toEqual(expected);
});

test("taskIds filtering precedes offset and preserves source order", async () => {
  const value = await fixture({ taskIds: ["task-19", "task-15", "task-11", "task-7"], offset: 1, maxTasks: 2 });
  expect((await execute(value)).run.taskIds).toEqual(["task-11", "task-15"]);
});

test("offset selects a slice of the reproducible shuffled order", async () => {
  const taskIds = ["task-2", "task-5", "task-9", "task-15", "task-19"];
  const all = await execute(await fixture({ taskIds, sampling: random() }));
  const value = await fixture({ taskIds, offset: 2, maxTasks: 2, sampling: random() });
  expect((await execute(value)).run.taskIds).toEqual(all.run.taskIds.slice(2, 4));
});

test.each([20, 21, Number.MAX_SAFE_INTEGER])("offset %s rejects an empty selection before solving", async offset => {
  const value = await fixture({ offset, maxTasks: 5 });
  await expect(execute(value)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: "Empty task selection" });
  expect(value.inputs).toEqual([]);
});

test.each([-1, 1.5, "2", null, true, [], {}, Number.MAX_SAFE_INTEGER + 1])("rejects invalid offset %j", async offset => {
  await expect(fixture({ offset })).rejects.toThrow(/run.offset must be a non-negative safe integer/);
});

test("random sampling is reproducible, without replacement, and reaches beyond the source prefix", async () => {
  const first = await fixture({ maxTasks: 5, sampling: random() });
  const snapshot = await execute(first);
  expect(snapshot.run.taskIds).toHaveLength(5);
  expect(new Set(snapshot.run.taskIds).size).toBe(5);
  expect(snapshot.run.taskIds.every(id => ids.includes(id))).toBe(true);
  expect(snapshot.run.taskIds.some(id => !ids.slice(0, 5).includes(id))).toBe(true);
  expect(first.inputs.map(input => input.id)).toEqual(snapshot.run.taskIds);

  const again = await execute(await fixture({ maxTasks: 5, sampling: random() }));
  expect(again.run.taskIds).toEqual(snapshot.run.taskIds);
  const changed = await execute(await fixture({ maxTasks: 5, sampling: random(43) }));
  expect([...changed.run.taskIds].sort()).not.toEqual([...snapshot.run.taskIds].sort());

  const stored = JSON.parse(await readFile(join(first.root, "runs", snapshot.run.runId, "manifest.json"), "utf8"));
  expect(stored.taskIds).toEqual(snapshot.run.taskIds);
  expect(stored.configSummary.run.sampling).toEqual(random());
  expect(first.config.persisted).toMatchObject({ run: { sampling: random() } });
});

test("taskIds restricts the sampling population before maxTasks is applied", async () => {
  const taskIds = ["task-19", "task-15", "task-11", "task-7"];
  const value = await fixture({ taskIds, maxTasks: 3, sampling: random() });
  const snapshot = await execute(value);
  expect(snapshot.run.taskIds).toHaveLength(3);
  expect(snapshot.run.taskIds.every(id => taskIds.includes(id))).toBe(true);
  expect(new Set(snapshot.run.taskIds).size).toBe(3);
});

test.each([undefined, 100])("random sampling retains all candidates when maxTasks is %s", async maxTasks => {
  const value = await fixture({ taskIds: ["task-2", "task-9", "task-15"], maxTasks, sampling: random(0) });
  const snapshot = await execute(value);
  expect([...snapshot.run.taskIds].sort()).toEqual(["task-15", "task-2", "task-9"]);
});

test("random sampling still rejects unknown task IDs before solving", async () => {
  const value = await fixture({ taskIds: ["unknown"], sampling: random() });
  await expect(execute(value)).rejects.toThrow(/unknown task IDs/i);
  expect(value.inputs).toEqual([]);
});

test.each([
  [null, /run.sampling/],
  [[], /run.sampling/],
  [{}, /strategy/],
  [{ strategy: "typo", seed: 42 }, /strategy/],
  [{ strategy: "random" }, /seed/],
  [{ strategy: "random", seed: null }, /seed/],
  [{ strategy: "random", seed: "42" }, /seed/],
  [{ strategy: "random", seed: -1 }, /seed/],
  [{ strategy: "random", seed: 1.5 }, /seed/],
  [{ strategy: "random", seed: 4_294_967_296 }, /seed/],
  [{ strategy: "random", seed: 42, replacement: true }, /replacement/],
])("rejects invalid sampling config %j", async (sampling, message) => {
  await expect(fixture({ sampling })).rejects.toThrow(message as RegExp);
});

test("the largest uint32 seed is accepted and saved without truncation", async () => {
  const value = await fixture({ sampling: random(4_294_967_295) });
  expect(value.config.persisted).toMatchObject({ run: { sampling: random(4_294_967_295) } });
});

test.each([{}, { offset: 4 }])("resume keeps the sampled task order and skips completed attempts with %j", async selection => {
  const run = { maxTasks: 5, sampling: random(), ...selection };
  const first = await fixture(run);
  const controller = new AbortController();
  const commit = first.components.store.commit.bind(first.components.store);
  first.components.store.commit = async (...args) => {
    await commit(...args);
    controller.abort();
  };
  const partial = await runEngine({ ...first, signal: controller.signal });
  expect(partial.run.status).toBe("cancelled");
  expect(partial.records).toHaveLength(1);
  expect(partial.records[0]?.executionStatus).toBe("completed");
  await first.dispose();

  const resumed = await fixture(run, first.root);
  const snapshot = await runEngine({ ...resumed, resumeDirectory: join(first.root, "runs", partial.run.runId), signal: new AbortController().signal });
  expect(snapshot.run.taskIds).toEqual(partial.run.taskIds);
  expect(resumed.inputs.map(input => input.id)).toEqual(partial.run.taskIds.slice(1));
  expect(snapshot.records[0]?.key).toEqual(partial.records[0]?.key);
  expect(snapshot.run.status).toBe("completed");
  expect(await resumed.components.store.listAttempts()).toHaveLength(5);
  await resumed.dispose();

  const changed = await fixture({ ...run, sampling: random(43) }, first.root);
  await expect(runEngine({ ...changed, resumeDirectory: join(first.root, "runs", partial.run.runId), signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed.inputs).toEqual([]);
  await changed.dispose();

  const changedOffset = await fixture({ ...run, offset: 5 }, first.root);
  await expect(runEngine({ ...changedOffset, resumeDirectory: join(first.root, "runs", partial.run.runId), signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changedOffset.inputs).toEqual([]);
});
