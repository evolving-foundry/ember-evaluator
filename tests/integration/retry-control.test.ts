import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { callControlChannel, openControlChannel } from "../../src/infrastructure/ipc/control-channel.js";
import { runEngine } from "../../src/application/run-engine.js";
import { controlTransaction, RetryControl, submitRetry } from "../../src/application/retry-control/mailbox.js";
import { harness } from "../fixtures/engine/fakes.js";

const fault = vi.hoisted(() => ({ target: "", remaining: 0, code: "EPERM" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === fault.target && fault.remaining-- > 0) throw Object.assign(new Error("injected file occupation"), { code: fault.code });
      return actual.rename(...args);
    }) };
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  fault.target = ""; fault.remaining = 0; fault.code = "EPERM";
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.clearAllMocks();
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retry-control-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function control() {
  const root = await directory();
  const warn = vi.fn();
  const server = await RetryControl.start(root, warn);
  cleanups.push(() => server.close());
  return { root, server, warn };
}

test("an idle coordinator performs no file reads, writes or lock acquisitions", async () => {
  const { root, server } = await control();
  await server.setAdmission(async () => ({ commit() {}, release() {} }));
  vi.clearAllMocks();
  await delay(650);
  expect(open).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
  expect(writeFile).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  await controlTransaction(root, async () => {});
  expect(rename).not.toHaveBeenCalled();
});

test("a separate Node process submits unicode requests through the coordinator IPC endpoint", async () => {
  const { root, server } = await control();
  const commit = vi.fn();
  await server.setAdmission(async requests => {
    for (const request of requests) { request.status = "accepted"; request.bindings = { "题目": "failed-attempt", ["__proto__"]: "failed-attempt" }; }
    return { commit, release() {} };
  });
  const state = JSON.parse(await readFile(join(root, "retry-control.json"), "utf8")) as { endpoint: string };
  const moduleUrl = pathToFileURL(resolve("src/infrastructure/ipc/control-channel.ts")).href;
  const script = `import { callControlChannel } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await callControlChannel(process.argv[1], { requestId: "child", taskIds: ["__proto__", "题目"], reason: "网络恢复" })));`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script, state.endpoint], { windowsHide: true });
  expect(JSON.parse(result.stdout)).toMatchObject({ active: true, request: { requestId: "child", status: "accepted", reason: "网络恢复" } });
  const replay = await submitRetry(root, { requestId: "child", taskIds: ["__proto__", "题目"] });
  expect(replay.request.status).toBe("accepted");
  expect(Object.hasOwn(replay.request.bindings, "__proto__")).toBe(true);
  expect(commit).toHaveBeenCalledTimes(1);
});

test("invalid IPC requests and conflicting request IDs do not change the mailbox or stop the server", async () => {
  const { root } = await control();
  const state = JSON.parse(await readFile(join(root, "retry-control.json"), "utf8")) as { endpoint: string };
  await expect(callControlChannel(state.endpoint, { requestId: "bad", taskIds: [123] })).rejects.toThrow("Invalid task selection");
  const first = await submitRetry(root, { requestId: "same", taskIds: ["a"] });
  expect(first.request.status).toBe("pending");
  await expect(submitRetry(root, { requestId: "same", taskIds: ["b"] })).rejects.toThrow("another selection");
  const replay = await submitRetry(root, { requestId: "same", taskIds: ["a"] });
  expect(replay.request.taskIds).toEqual(["a"]);
  expect(JSON.parse(await readFile(join(root, "retry-control.json"), "utf8")).requests).toHaveLength(1);
});

test("requests acknowledged during preparation are admitted once after the executor is ready", async () => {
  const { root, server } = await control();
  expect((await submitRetry(root, { requestId: "preparing", taskIds: ["a"] })).request.status).toBe("pending");
  const commit = vi.fn(), release = vi.fn();
  await server.setAdmission(async requests => {
    expect(requests.map(request => request.requestId)).toEqual(["preparing"]);
    requests[0]!.status = "accepted";
    requests[0]!.bindings.a = "original-failure";
    return { commit, release };
  });
  expect((await submitRetry(root, { requestId: "preparing", taskIds: ["a"] })).request).toMatchObject({
    status: "accepted", bindings: { a: "original-failure" },
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

test("offline recovery claims a pending request atomically and rejects a second claim", async () => {
  const root = await directory(), value = harness(root);
  cleanups.push(() => value.components.dispose());
  value.config.experiment.run.taskIds = ["a"];
  const solve = value.components.solver.solve;
  value.components.solver.solve = async () => { throw new Error("ECONNRESET"); };
  const failed = await runEngine({ ...value, signal: new AbortController().signal });
  const runRoot = join(value.config.experiment.output.directory, failed.run.runId);
  await value.components.store.close();
  expect((await submitRetry(runRoot, { requestId: "offline", taskIds: ["a"] })).request.status).toBe("pending");
  value.components.solver.solve = solve;
  const recovered = await runEngine({ ...value, resumeDirectory: runRoot, retryTaskIds: ["a"], retryRequestId: "offline", signal: new AbortController().signal });
  expect(recovered.run.status).toBe("completed");
  expect(recovered.attemptHistory).toHaveLength(2);
  await value.components.store.close();
  await expect(runEngine({ ...value, resumeDirectory: runRoot, retryTaskIds: ["a"], retryRequestId: "offline", signal: new AbortController().signal }))
    .rejects.toThrow("already claimed");
  expect((await value.components.store.listAttempts())).toHaveLength(2);
});

test("a stale Ray stopped-owner snapshot cannot disable a new recovery coordinator", async () => {
  const { root, server } = await control();
  const owner = await controlTransaction(root, async ({ pid, host, endpoint }) => ({ pid, host, ...(endpoint ? { endpoint } : {}) }));
  await server.close();
  const recovery = await RetryControl.start(root, vi.fn());
  cleanups.push(() => recovery.close());
  const request = await submitRetry(root, { requestId: "late", taskIds: [] }, { stoppedCoordinator: owner });
  expect(request.active).toBe(true);
  await controlTransaction(root, async state => { expect(state.accepting).toBe(true); expect(state.endpoint).not.toBe(owner.endpoint); });
});

test("shutdown waits for an admission already saving its result", async () => {
  const { root, server } = await control();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const commit = vi.fn();
  await server.setAdmission(async requests => {
    entered.resolve(); await release.promise;
    for (const request of requests) { request.status = "accepted"; request.bindings.a = "failure"; }
    return { commit, release() {} };
  });
  const submitted = submitRetry(root, { requestId: "closing", taskIds: ["a"] });
  await entered.promise;
  const closed = server.close();
  release.resolve();
  await Promise.all([submitted, closed]);
  expect(commit).toHaveBeenCalledTimes(1);
  const state = JSON.parse(await readFile(join(root, "retry-control.json"), "utf8"));
  expect(state).toMatchObject({ accepting: false, requests: [{ requestId: "closing", status: "completed" }] });
  expect(state.endpoint).toBeUndefined();
});

test("temporary rename denial retries the same complete temporary file", async () => {
  const root = await directory();
  await controlTransaction(root, async () => {});
  fault.target = join(root, "retry-control.json"); fault.remaining = 2;
  vi.clearAllMocks();
  await controlTransaction(root, async state => { state.accepting = true; });
  expect(rename).toHaveBeenCalledTimes(3);
  expect(new Set(vi.mocked(rename).mock.calls.map(args => args[0])).size).toBe(1);
  expect(writeFile).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(fault.target, "utf8"))).toMatchObject({ accepting: true });
  expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test.each(["EPERM", "EACCES", "EBUSY"])("persistent %s preserves the old file and never commits admission", async code => {
  const root = await directory();
  await controlTransaction(root, async () => {});
  const original = await readFile(join(root, "retry-control.json"), "utf8");
  fault.target = join(root, "retry-control.json"); fault.remaining = 10; fault.code = code;
  vi.clearAllMocks();
  const committed = vi.fn();
  await expect(controlTransaction(root, async state => { state.accepting = true; }, { afterCommit: committed })).rejects.toMatchObject({ code });
  expect(rename).toHaveBeenCalledTimes(7);
  expect(committed).not.toHaveBeenCalled();
  expect(await readFile(fault.target, "utf8")).toBe(original);
  expect(await readdir(root)).toEqual(["retry-control.json"]);
});

test("a failed manual admission does not cancel active tasks; the same ID can be submitted successfully", async () => {
  const root = await directory();
  const value = harness(root);
  cleanups.push(() => value.components.dispose());
  value.config.experiment.run.onError = "continue";
  const failed = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
  const solve = value.components.solver.solve;
  let calls = 0;
  let activeSignal: AbortSignal | undefined;
  value.components.solver.solve = async (...args) => {
    if (args[0].id === "a" && ++calls === 1) throw new Error("ECONNRESET");
    if (args[0].id === "b") { activeSignal = args[2].signal; await held.promise; }
    return solve(...args);
  };
  const warnings: string[] = [];
  const running = runEngine({ ...value, signal: new AbortController().signal, onProgress: event => {
    if (event.phase === "task" && event.taskId === "a") failed.resolve();
    if (event.warning) warnings.push(event.message);
  } });
  try {
    await failed.promise;
    const run = (await value.components.store.snapshot()).run;
    const runRoot = join(value.config.experiment.output.directory, run.runId);
    fault.target = join(runRoot, "retry-control.json"); fault.remaining = 7; fault.code = "EPERM";
    await expect(submitRetry(runRoot, { requestId: "save-denied", taskIds: ["a"] })).rejects.toThrow("save-denied");
    expect(calls).toBe(1);
    expect(activeSignal?.aborted).toBe(false);
    expect(JSON.parse(await readFile(fault.target, "utf8"))).toMatchObject({ requests: [] });
    expect(warnings.some(message => message.includes("injected file occupation"))).toBe(true);
    const request = await submitRetry(runRoot, { requestId: "save-denied", taskIds: ["a"] });
    expect(request.request.status).toBe("accepted");
    await submitRetry(runRoot, { requestId: "save-denied", taskIds: ["a"] });
  } finally { held.resolve(); await running; }
  const final = await running;
  expect(final.run.status).toBe("completed");
  expect(final.attemptHistory).toHaveLength(4);
  expect(calls).toBe(2);
});

test.each(["startup", "shutdown"])("control persistence failure at %s leaves successful evaluations intact", async phase => {
  const root = await directory();
  const value = harness(root);
  cleanups.push(() => value.components.dispose());
  const runId = "control-failure";
  fault.target = join(value.config.experiment.output.directory, runId, "retry-control.json");
  fault.code = "EPERM";
  if (phase === "startup") fault.remaining = 7;
  const warnings: string[] = [];
  const result = await runEngine({ ...value, runId, signal: new AbortController().signal, onProgress: event => {
    if (phase === "shutdown" && event.phase === "task" && event.summary?.completed === 3) fault.remaining = 7;
    if (event.warning) warnings.push(event.message);
  } });
  expect(result.run.status).toBe("completed");
  expect(result.records.every(record => record.verdict?.score === 1)).toBe(true);
  expect(warnings.some(message => message.includes("injected file occupation"))).toBe(true);
});

test("closing the channel releases clients that never sent a request", async () => {
  const server = await openControlChannel(async () => ({}), vi.fn());
  const socket = createConnection(server.endpoint);
  socket.on("error", () => {});
  await new Promise<void>(resolve => socket.once("connect", resolve));
  await server.close();
  socket.destroy();
});

test.skipIf(process.platform !== "win32")("real Windows handle without delete sharing temporarily blocks replacement", async () => {
  const root = await directory();
  await controlTransaction(root, async () => {});
  const script = "$handle = [IO.File]::Open($env:RETRY_PROBE_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite); try { [Console]::WriteLine('held'); Start-Sleep -Milliseconds 450 } finally { $handle.Dispose() }";
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, RETRY_PROBE_FILE: join(root, "retry-control.json") }, stdio: ["ignore", "pipe", "pipe"],
  });
  const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(`holder exit ${code}`))); });
  try {
    await Promise.race([new Promise<void>(resolve => child.stdout.once("data", () => resolve())), ended.then(() => { throw new Error("holder exited before acquiring the file"); })]);
    vi.clearAllMocks();
    await controlTransaction(root, async state => { state.accepting = true; });
    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThan(1);
    expect(JSON.parse(await readFile(join(root, "retry-control.json"), "utf8"))).toMatchObject({ accepting: true });
  } finally { await ended; }
});
