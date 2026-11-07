import { afterEach, expect, test, vi } from "vitest";
import { preparationConcurrency, withPreparationTimeout } from "../../src/core/preparation/preparation-timeout.js";
import type { PreparationStageTiming } from "../../src/core/contracts/result.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";

afterEach(() => vi.useRealTimers());

test.each([1, 4, 10, 32])("concurrency %s allows min(C,10) times the base and cancels admitted work", async concurrency => {
  vi.useFakeTimers();
  let active: AbortSignal | undefined;
  let evidence: PreparationStageTiming | undefined;
  const work = withPreparationTimeout("solve", 600, concurrency, new AbortController().signal,
    signal => new Promise<never>((_resolve, reject) => {
      active = signal;
      signal.addEventListener("abort", () => reject(new DOMException("adapter stopped", "AbortError")), { once: true });
    }), timing => { evidence = timing; });
  const rejected = expect(work).rejects.toMatchObject({ code: "ENV_PREPARATION_TIMEOUT" });
  const seconds = 600 * Math.min(concurrency, 10);
  expect(evidence).toMatchObject({ baseSeconds: 600, concurrency, multiplier: Math.min(concurrency, 10), timeoutSeconds: seconds });
  await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
  expect(active?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(active?.aborted).toBe(true);
  expect(evidence?.finishedAt).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("success clears its timer and parent cancellation preserves the user reason", async () => {
  vi.useFakeTimers();
  expect(await withPreparationTimeout("verify", 600, 2, new AbortController().signal, async () => 42)).toBe(42);
  expect(vi.getTimerCount()).toBe(0);
  const parent = new AbortController();
  const reason = new Error("user stopped");
  const work = withPreparationTimeout("verify", 600, 2, parent.signal, signal => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
  }));
  const rejected = expect(work).rejects.toBe(reason);
  parent.abort(reason);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

test("node limits and selection size restrict C; execution on other nodes never enlarges it", () => {
  expect(preparationConcurrency(32, 1)).toBe(1);
  expect(preparationConcurrency(32, 50, 4)).toBe(4);
  expect(preparationConcurrency(2, 50, 32)).toBe(2);
});

test("a deadline must not hide a cleanup failure that requires dispatch to stop", async () => {
  vi.useFakeTimers();
  const work = withPreparationTimeout("solve", 1, 1, new AbortController().signal,
    signal => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new EvaluatorError("CLEANUP_FAILED", "process exit unconfirmed")), { once: true });
    }));
  const rejected = expect(work).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
});

test("separated verification preparation calls share their budget without counting intervening execution", async () => {
  vi.useFakeTimers();
  await withPreparationTimeout("verify", 1, 1, new AbortController().signal, async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  await vi.advanceTimersByTimeAsync(10_000);
  const work = withPreparationTimeout("verify", 1, 1, new AbortController().signal,
    signal => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    undefined, 400);
  const rejected = expect(work).rejects.toMatchObject({ code: "ENV_PREPARATION_TIMEOUT" });
  await vi.advanceTimersByTimeAsync(599);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147484])("invalid or overflowing time limit %s is rejected", async seconds => {
  await expect(withPreparationTimeout("solve", seconds, 1, new AbortController().signal, async () => {}))
    .rejects.toThrow(/preparation timeout/i);
});
