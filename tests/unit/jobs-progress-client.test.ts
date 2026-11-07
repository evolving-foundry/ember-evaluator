import { afterEach, expect, test, vi } from "vitest";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { LiveOperation } from "../../src/core/progress/live-progress.js";
import { JobsProgressMailbox } from "../../src/infrastructure/ray/jobs-progress.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";

vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
  const signal = options?.signal;
  const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(value); }, ms);
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
}) }));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function clock() { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }); }

test("Jobs client receives RAM previews before completion and never routes them to formal logs", async () => {
  clock(); const client = new JobsClient("https://unused", Buffer.alloc(0), "token");
  const mailbox = new JobsProgressMailbox(); const values: ProgressEvent[] = [];
  const operation = new LiveOperation(event => values.push(event), { phase: "solve", message: "waiting", taskId: "task" });
  mailbox.put("job", { schemaVersion: 1, publisherId: "source", sequence: 1, events: values });
  let ended = false;
  vi.spyOn(client, "call").mockImplementation(async path => {
    if (path.endsWith("/progress")) return mailbox.get("job");
    if (path.endsWith("/logs")) return { logs: "formal line\n" };
    return { status: ended ? "SUCCEEDED" : "RUNNING" };
  });
  const received: ProgressEvent[] = []; const logs: string[] = [];
  const pending = client.attach("job", text => logs.push(text), new AbortController().signal, event => received.push(event));
  await vi.advanceTimersByTimeAsync(1000);
  expect(received.some(event => event.live?.status === "started")).toBe(true);
  operation.finish(); mailbox.put("job", { schemaVersion: 1, publisherId: "source", sequence: 2, ended: true, events: values.slice(-1) });
  ended = true; await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toBe(0); expect(received.some(event => event.live?.status === "completed")).toBe(true);
  expect(logs.join("")).not.toContain("waiting"); expect(logs.join("")).not.toContain("\x1b");
});

test("a reachable Jobs gateway with a stale publisher still reports interrupted progress and later recovers", async () => {
  clock(); const client = new JobsClient("https://unused", Buffer.alloc(0), "token");
  let sourceAge = 20_000; let ended = false;
  const call = vi.spyOn(client, "call").mockImplementation(async path => {
    if (path.endsWith("/progress")) return { schemaVersion: 1, publisherId: "source", sequence: 1, events: [], ageMs: sourceAge };
    if (path.endsWith("/logs")) return { logs: "" };
    return { status: ended ? "SUCCEEDED" : "RUNNING" };
  });
  const events: ProgressEvent[] = []; const signal = new AbortController().signal;
  const following = client.attach("job", () => {}, signal, event => events.push(event));
  await vi.advanceTimersByTimeAsync(12_000);
  expect(events.filter(event => event.connection === "interrupted")).toHaveLength(1);
  sourceAge = 0; await vi.advanceTimersByTimeAsync(1000);
  expect(events.some(event => event.connection === "connected")).toBe(true); expect(signal.aborted).toBe(false);
  ended = true; await vi.advanceTimersByTimeAsync(1000); expect(await following).toBe(0);
  expect(call.mock.calls.some(([path]) => path.endsWith("/cancel"))).toBe(false);
});

test("old Jobs gateways warn once and continue following their result", async () => {
  clock(); const client = new JobsClient("https://unused", Buffer.alloc(0), "token"); let ended = false;
  vi.spyOn(client, "call").mockImplementation(async path => {
    if (path.endsWith("/progress")) throw Object.assign(new Error("not found"), { statusCode: 404 });
    if (path.endsWith("/logs")) return { logs: "formal\n" };
    return { status: ended ? "SUCCEEDED" : "RUNNING" };
  });
  const logs: string[] = [];
  const following = client.attach("job", line => logs.push(line), new AbortController().signal, () => {});
  await vi.advanceTimersByTimeAsync(1000); ended = true; await vi.advanceTimersByTimeAsync(1000);
  expect(await following).toBe(0); expect(logs.filter(line => line.includes("does not support live progress"))).toHaveLength(1);
});
