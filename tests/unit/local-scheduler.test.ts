import { expect, test, vi } from "vitest";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import type { TaskJob, AttemptRecord } from "../../src/index.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";

const jobs: TaskJob[] = Array.from({ length: 5 }, (_, index) => ({
  runId: "run", taskId: `t${index}`, attemptId: `a${index}`,
  ref: { id: `t${index}`, recordKey: index }, configFingerprint: "hash",
}));
async function* ready(items: TaskJob[]) { yield* items; }
const record = (job: TaskJob) => storeRecord({ runId: job.runId, taskId: job.taskId, attemptId: job.attemptId });

test("50 tasks maintain 25 execution slots and refill while slower peers remain active", async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => ({ ...jobs[0]!, taskId: `t${index}`, attemptId: `a${index}`, ref: { id: `t${index}`, recordKey: index } }));
  const gates = fifty.map(() => Promise.withResolvers<void>());
  const started: string[] = [];
  let active = 0, maximum = 0;
  const stream = new LocalScheduler(25).executeReady(ready(fifty), async job => {
    started.push(job.taskId); maximum = Math.max(maximum, ++active);
    await gates[Number(job.ref.recordKey)]!.promise;
    active--;
    return record(job);
  }, new AbortController().signal)[Symbol.asyncIterator]();
  const first = stream.next();
  await vi.waitFor(() => expect(started).toHaveLength(25));
  gates[7]!.resolve();
  expect((await first).value?.key.taskId).toBe("t7");
  await vi.waitFor(() => expect(started).toHaveLength(26));
  expect(active).toBe(25);
  gates.forEach(gate => gate.resolve());
  let count = 1;
  for (let item = await stream.next(); !item.done; item = await stream.next()) count++;
  expect(count).toBe(50); expect(maximum).toBe(25); expect(active).toBe(0);
});
async function collect(iterator: AsyncIterable<AttemptRecord>) {
  const results = []; for await (const result of iterator) results.push(result); return results;
}

test("cancelled batch never starts tasks", async () => {
  const controller = new AbortController(); controller.abort(); let starts = 0;
  expect(await collect(new LocalScheduler(2).executeReady(ready(jobs), async job => { starts++; return record(job); }, controller.signal))).toEqual([]);
  expect(starts).toBe(0);
});

test.each([0, -1, 1.5, NaN, Infinity])("rejects invalid concurrency %s", value => {
  expect(() => new LocalScheduler(value)).toThrow(/concurrency/);
});

test("bounds execution and yields completion order", async () => {
  const gates = jobs.map(() => Promise.withResolvers<void>()); const started: string[] = []; let active = 0; let maximum = 0;
  const stream = new LocalScheduler(2).executeReady(ready(jobs), async job => {
    started.push(job.taskId); active++; maximum = Math.max(maximum, active);
    await gates[job.ref.recordKey as number]!.promise; active--; return record(job);
  }, new AbortController().signal)[Symbol.asyncIterator]();
  const first = stream.next();
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1"]));
  gates[1]!.resolve(); expect((await first).value?.key.taskId).toBe("t1");
  const second = stream.next(); await vi.waitFor(() => expect(started).toEqual(["t0", "t1", "t2"]));
  gates[0]!.resolve(); expect((await second).value?.key.taskId).toBe("t0");
  gates[2]!.resolve(); gates[3]!.resolve(); gates[4]!.resolve();
  const rest = []; for (let item = await stream.next(); !item.done; item = await stream.next()) rest.push(item.value);
  expect(rest).toHaveLength(3); expect(maximum).toBe(2); expect(active).toBe(0);
});

test("keeps dispatching while the consumer is paused and preserves settlement order", async () => {
  const gates = jobs.map(() => Promise.withResolvers<void>()); const started: string[] = [];
  const stream = new LocalScheduler(2).executeReady(ready(jobs), async job => {
    started.push(job.taskId);
    await gates[job.ref.recordKey as number]!.promise;
    return record(job);
  }, new AbortController().signal)[Symbol.asyncIterator]();

  const first = stream.next();
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1"]));
  gates[0]!.resolve();
  expect((await first).value?.key.taskId).toBe("t0");
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1", "t2"]));

  gates[2]!.resolve();
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1", "t2", "t3"]));
  gates[1]!.resolve();
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1", "t2", "t3", "t4"]));

  expect((await stream.next()).value?.key.taskId).toBe("t2");
  expect((await stream.next()).value?.key.taskId).toBe("t1");
  gates[3]!.resolve(); gates[4]!.resolve();
  const rest = []; for (let item = await stream.next(); !item.done; item = await stream.next()) rest.push(item.value);
  expect(rest.map(item => item.key.taskId)).toEqual(["t3", "t4"]);
});

test("cancellation drains active work and leaves the queue unstarted", async () => {
  const controller = new AbortController(); const started: string[] = []; const stopped: string[] = [];
  const done = collect(new LocalScheduler(2).executeReady(ready(jobs), async (job, signal) => {
    started.push(job.taskId);
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped.push(job.taskId); resolve(); }, { once: true }));
    return { ...record(job), executionStatus: "cancelled", scoreStatus: "invalid", };
  }, controller.signal));
  await vi.waitFor(() => expect(started).toHaveLength(2));
  controller.abort();
  expect((await done).map(item => item.executionStatus)).toEqual(["cancelled", "cancelled"]);
  await vi.waitFor(() => expect(started).toEqual(["t0", "t1"])); expect(stopped).toEqual(started);
});

test("fatal executor error cancels peers, waits for cleanup and prevents queued dispatch", async () => {
  const fail = Promise.withResolvers<void>(); let cleaned = false; const started: string[] = [];
  const done = collect(new LocalScheduler(2).executeReady(ready(jobs), async (job, signal) => {
    started.push(job.taskId);
    if (job.taskId === "t0") { await fail.promise; throw new Error("store unavailable"); }
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true }));
    return record(job);
  }, new AbortController().signal));
  await vi.waitFor(() => expect(started).toHaveLength(2));
  fail.resolve(); await expect(done).rejects.toThrow("store unavailable");
  expect(cleaned).toBe(true); expect(started).toEqual(["t0", "t1"]);
});

test("readiness scheduling yields finished work while the next ready task is delayed", async () => {
  const gate = Promise.withResolvers<void>();
  async function* source() {
    yield jobs[0]!;
    await gate.promise;
    yield jobs[1]!;
  }
  const stream = new LocalScheduler(2).executeReady(source(), async job => record(job), new AbortController().signal)[Symbol.asyncIterator]();
  const first = await stream.next();
  expect(first.value?.key.taskId).toBe("t0");
  gate.resolve();
  expect((await stream.next()).value?.key.taskId).toBe("t1");
  expect((await stream.next()).done).toBe(true);
});

test("closing readiness scheduling interrupts its pending input and waits for executor cleanup", async () => {
  let reads = 0, returned = false, cleaned = false;
  const pending = Promise.withResolvers<IteratorResult<TaskJob>>();
  const started = Promise.withResolvers<void>();
  const source: AsyncIterable<TaskJob> = { [Symbol.asyncIterator]: () => ({
    async next() { return reads++ < 2 ? { done: false, value: jobs[reads - 1]! } : pending.promise; },
    async return() { returned = true; pending.resolve({ done: true, value: undefined }); return { done: true, value: undefined }; },
  }) };
  const stream = new LocalScheduler(2).executeReady(source, async (job, signal) => {
    if (job.taskId === "t0") { await started.promise; return record(job); }
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true }));
    return record(job);
  }, new AbortController().signal)[Symbol.asyncIterator]();
  expect((await stream.next()).value?.key.taskId).toBe("t0");
  await vi.waitFor(() => expect(reads).toBe(3));
  await stream.return?.();
  expect(returned).toBe(true);
  expect(cleaned).toBe(true);
});

test("readiness input failures cancel active executors and drain them before rejecting", async () => {
  let cleaned = false;
  const started = Promise.withResolvers<void>();
  async function* source() { yield jobs[0]!; await started.promise; throw new Error("prepare failed"); }
  const done = collect(new LocalScheduler(2).executeReady(source(), async (job, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { cleaned = true; resolve(); }, { once: true }));
    return record(job);
  }, new AbortController().signal));
  await expect(done).rejects.toThrow("prepare failed");
  expect(cleaned).toBe(true);
});
