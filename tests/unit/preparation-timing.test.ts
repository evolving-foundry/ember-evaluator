import { expect, test } from "vitest";
import { assertPreparationDiagnostics, validPreparationBudget, assertEnvironmentTimeouts } from "../../src/core/preparation/preparation-validation.js";
import { assertAttemptRecord } from "../../src/core/results/record-validation.js";
import { DockerBuildCache } from "../../src/infrastructure/containers/build-cache.js";
import { storeRecord, storeRun } from "../fixtures/results/store-fixture.js";
import { computeDuration } from "../../src/plugins/metrics/duration.js";

const round = () => ({ mode: "pipeline", concurrency: 2, lookahead: 3, taskIds: ["a"], tasks: [{
  taskId: "a", status: "ready", queuedAt: "2026-10-08T00:00:00Z", startedAt: "2026-10-08T00:00:01Z",
  finishedAt: "2026-10-08T00:00:02Z", queueDurationMs: 1000, durationMs: 1000, phaseDurationMs: { solveEnvironment: 1000 },
  imagePhaseDurationMs: { solve: { imageMs: 800, runtimeMs: 100, solverMs: 100, cache: { image: "built" } } },
}] });

test("optional preparation diagnostics accept historical absence and valid receipts", () => {
  expect(() => assertPreparationDiagnostics({ taskIds: ["a"] })).not.toThrow();
  expect(() => assertPreparationDiagnostics(round())).not.toThrow();
});

test("historical round budgets keep their meaning while only the new policy permits no round limit", () => {
  const historical = { startedAt: "2026-10-30T00:00:00Z", deadlineAt: "2026-10-30T00:10:00Z", budgetSeconds: 600 };
  expect(validPreparationBudget(historical)).toBe(true);
  expect(validPreparationBudget({ ...historical, budgetSeconds: null, deadlineAt: null })).toBe(false);
  expect(validPreparationBudget({ ...historical, budgetSeconds: null, deadlineAt: null, timeoutPolicy: "task-concurrency-v1" })).toBe(true);
  expect(validPreparationBudget({ ...historical, deadlineAt: null, mode: "pipeline", timeoutPolicy: "task-concurrency-v1" })).toBe(true);
});

test("environment timing evidence enforces the cap and the recorded absolute stage deadline", () => {
  const timing = { baseSeconds: 600, concurrency: 32, multiplier: 10, timeoutSeconds: 6000,
    startedAt: "2026-10-30T00:00:00Z", deadlineAt: "2026-10-30T01:40:00Z", finishedAt: "2026-10-30T00:00:01Z" };
  expect(() => assertEnvironmentTimeouts({ solve: timing })).not.toThrow();
  for (const patch of [{ multiplier: 32, timeoutSeconds: 19200 }, { baseSeconds: "600" }, { deadlineAt: timing.startedAt }])
    expect(() => assertEnvironmentTimeouts({ solve: { ...timing, ...patch } })).toThrow();
});
test.each([
  { concurrency: 0 }, { lookahead: 1 }, { mode: "unknown" }, { tasks: [] },
  { tasks: [{ ...round().tasks[0], taskId: "other" }] },
  { tasks: [{ ...round().tasks[0], durationMs: -1 }] },
  { tasks: [{ ...round().tasks[0], durationMs: null }] },
  { tasks: [{ ...round().tasks[0], imagePhaseDurationMs: { solve: { imageMs: Infinity, runtimeMs: 0, solverMs: 0 } } }] },
  { tasks: [{ ...round().tasks[0], imagePhaseDurationMs: { solve: { imageMs: 1, runtimeMs: 0, solverMs: 0, cache: { image: "guess" } } } }] },
])("rejects malformed preparation diagnostics %j", patch => {
  expect(() => assertPreparationDiagnostics({ ...round(), ...patch })).toThrow(/Invalid preparation/);
});
test("readiness records accept old results and reject invalid queue receipts", () => {
  const record = storeRecord();
  expect(() => assertAttemptRecord(record)).not.toThrow();
  expect(() => assertAttemptRecord({ ...record, readiness: { roundId: "round", readyAt: record.startedAt, queueDurationMs: 0 } })).not.toThrow();
  expect(() => assertAttemptRecord({ ...record, readiness: { roundId: "round", readyAt: record.startedAt, queueDurationMs: -1 } })).toThrow("readiness");
});
test("cache diagnostics distinguish merged in-flight builds from completed memory reuse", async () => {
  const cache = new DockerBuildCache<string>();
  const gate = Promise.withResolvers<string>();
  const signal = new AbortController().signal;
  const sources: string[] = [];
  const build = cache.get("key", signal, () => gate.promise);
  const shared = cache.get("key", signal, () => { throw new Error("duplicate build"); }, source => sources.push(source));
  gate.resolve("image");
  expect(await Promise.all([build, shared])).toEqual(["image", "image"]);
  expect(await cache.get("key", signal, () => { throw new Error("duplicate build"); }, source => sources.push(source))).toBe("image");
  expect(sources).toEqual(["shared", "memory"]);
});

test("observed execution concurrency counts overlapping intervals without adding them to wall time", () => {
  const a = storeRecord();
  a.finishedAt = "2026-09-18T00:00:04.000Z";
  a.readiness = { roundId: "round", readyAt: a.startedAt, queueDurationMs: 25 };
  const b = storeRecord({ ...a.key, taskId: "b", attemptId: "attempt-2" });
  b.startedAt = "2026-09-18T00:00:01.000Z";
  b.finishedAt = "2026-09-18T00:00:03.000Z";
  b.readiness = { roundId: "round", readyAt: b.startedAt, queueDurationMs: 75 };
  const stats = computeDuration({ run: { ...storeRun, durationMs: 4000 }, records: [a, b], pendingTaskIds: [], digest: "test" });
  expect(stats.observedExecutionConcurrency).toBe(2);
  expect(stats.readyQueue?.meanMs).toBe(50);
  expect(stats.runWallTimeMs).toBe(4000);
});
