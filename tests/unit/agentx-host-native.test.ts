import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({ container: false, access: vi.fn(), execute: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: native.access }));
vi.mock("node:child_process", () => ({ execFile: native.execute, spawn: native.spawn }));

import { checkHostTelemetry, startHostTelemetry } from "../../src/runtimes/agentx/host-telemetry.js";

beforeEach(() => {
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", undefined);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", undefined);
  vi.stubEnv("PYTHON_BIN", undefined);
  native.container = false;
  native.access.mockReset().mockImplementation(async () => {
    if (!native.container) throw new Error("absent container marker");
  });
  native.execute.mockReset().mockImplementation((_file, _args, _options, callback) => {
    callback(null, "", "");
  });
  native.spawn.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

test("native doctor only probes existing Python and npu-smi availability without querying a device", async () => {
  vi.stubEnv("PYTHON_BIN", "/existing/python3.12");
  await checkHostTelemetry(new AbortController().signal);
  expect(native.execute).toHaveBeenCalledOnce();
  expect(native.execute.mock.calls[0]?.slice(0, 2)).toEqual(["/existing/python3.12", ["-B", "-c",
    "import sys,shutil; assert sys.version_info >= (3,9); assert shutil.which('npu-smi')"]]);
  expect(native.spawn).not.toHaveBeenCalled();
});

test("native run without a management channel starts the fixed helper and closes it after finish", async () => {
  const calls: Record<string, unknown>[] = [];
  const target = { deviceId: 4, chipId: 0, endpoint: "http://127.0.0.1:12345/metrics", errors: [] };
  const stdout = new PassThrough();
  const stdin = new Writable({ write(bytes: Buffer, _encoding, done) {
    const message = JSON.parse(bytes.toString()) as Record<string, unknown>;
    calls.push(message);
    setImmediate(() => stdout.write(JSON.stringify({ schemaVersion: 1, type: message.op === "sample" ? "ready" : "finished", targets: [target] }) + "\n"));
    done();
  } });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn(() => { stdout.end(); }) });
  native.spawn.mockReturnValue(child);
  const controller = new AbortController();
  const sampling = await startHostTelemetry([{ deviceId: 4 }], "/work/attempt/telemetry", controller.signal, "/runtime/venv/bin/python");
  expect(native.spawn).toHaveBeenCalledWith("/runtime/venv/bin/python", ["-B", "-u", expect.stringMatching(/host_telemetry\.py$/u),
    "--artifacts", "/work/attempt/telemetry"], expect.objectContaining({ stdio: ["pipe", "pipe", "ignore"] }));
  expect(sampling.targets).toEqual([target]);
  controller.abort();
  expect(await sampling.finish()).toEqual([target]);
  expect(await sampling.finish()).toEqual([target]);
  expect(calls).toEqual([{ schemaVersion: 1, op: "sample", devices: [{ deviceId: 4 }] }, { schemaVersion: 1, op: "finish" }]);
  expect(child.kill).toHaveBeenCalledOnce();
});

test("a container without a host control channel never falls back to sampling inside the container", async () => {
  native.container = true;
  await expect(checkHostTelemetry(new AbortController().signal)).rejects.toThrow("cannot run inside a container");
  const sampling = await startHostTelemetry([{ deviceId: 4 }], "/unused", new AbortController().signal);
  expect(sampling.targets).toEqual([{ deviceId: 4, endpoint: null, errors: [expect.stringContaining("cannot run inside a container")] }]);
  expect(native.execute).not.toHaveBeenCalled();
  expect(native.spawn).not.toHaveBeenCalled();
});

test("a management container uses the configured host channel without probing or spawning local sampling", async () => {
  native.container = true;
  const target = { deviceId: 4, chipId: 0, endpoint: "http://127.0.0.1:12345/metrics", errors: [] };
  const operations: unknown[] = [];
  const server = createServer(socket => {
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, boundary)) as Record<string, unknown>;
        buffer = buffer.slice(boundary + 1); operations.push(request.op);
        socket.write(JSON.stringify({ schemaVersion: 1, type: request.op === "ping" ? "pong" : request.op === "sample" ? "ready" : "finished", targets: [target] }) + "\n");
      }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  try {
    await checkHostTelemetry(new AbortController().signal);
    const sampling = await startHostTelemetry([{ deviceId: 4 }], "/unused", new AbortController().signal);
    expect(await sampling.finish()).toEqual([target]);
    expect(operations).toEqual(["ping", "sample", "finish"]);
    expect(native.access).not.toHaveBeenCalled();
    expect(native.execute).not.toHaveBeenCalled();
    expect(native.spawn).not.toHaveBeenCalled();
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
});
