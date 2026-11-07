import { expect, test, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { waitForProfileRetry } from "../../src/adapters/kernel/profile.js";

vi.mock("node:timers/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:timers/promises")>(),
  setTimeout: vi.fn(async () => undefined),
}));

test("profiler retries honor explicit delays and keep exponential waits within Node timer range", async () => {
  const signal = new AbortController().signal;
  await waitForProfileRetry(1, 0, signal);
  expect(delay).not.toHaveBeenCalled();
  await waitForProfileRetry(10, 37, signal);
  expect(delay).toHaveBeenCalledExactlyOnceWith(37, undefined, { signal });
  vi.mocked(delay).mockClear();
  await waitForProfileRetry(22, undefined, signal);
  expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([2147483647, 2046820353]);
});
