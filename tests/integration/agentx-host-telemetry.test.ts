import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { checkHostTelemetry, startHostTelemetry } from "../../src/runtimes/agentx/host-telemetry.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import { workload, profileExport } from "../fixtures/agentx/export.js";
import { serverMetricsEvidence, telemetryConfig } from "../fixtures/agentx/server-metrics.js";
import { diagnose } from "../../src/application/diagnostics/doctor.js";
import { loadConfig } from "../../src/application/config.js";
import { stringify } from "yaml";

afterEach(() => vi.unstubAllEnvs());
const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3,9)"], { windowsHide: true }).status === 0;

test.skipIf(!available)("host protocol enforces read-only commands, explicit cards and connection-owned sampling", () => {
  const result = spawnSync(python, ["-B", resolve("tests/fixtures/agentx/check-host-telemetry.py"), resolve("src/runtimes/agentx/assets")],
    { encoding: "utf8", windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Ran 6 tests");
});

test("CLI uses host sampling for doctor and waits for cleanup even when the task is cancelled", async () => {
  const calls: Record<string, unknown>[] = [];
  const target = { deviceId: 4, chipId: 0, endpoint: "http://127.0.0.1:12345/metrics", errors: [] };
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(buffer.slice(0, boundary)) as Record<string, unknown>;
        buffer = buffer.slice(boundary + 1); calls.push(value);
        const type = value.op === "ping" ? "pong" : value.op === "finish" ? "finished" : "ready";
        socket.write(JSON.stringify({ schemaVersion: 1, type, targets: [target] }) + "\n");
      }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  try {
    await checkHostTelemetry(new AbortController().signal);
    expect(calls.map(call => call.op)).toEqual(["ping"]);
    const controller = new AbortController();
    const session = await startHostTelemetry([{ deviceId: 4 }], "unused-fixture-path", controller.signal);
    expect(session.targets).toEqual([target]);
    controller.abort();
    expect(await session.finish()).toEqual([target]);
    expect(await session.finish()).toEqual([target]);
    expect(calls.map(call => call.op)).toEqual(["ping", "sample", "finish"]);
    expect(calls[1]).toMatchObject({ devices: [{ deviceId: 4 }], token: "fixture-token" });
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
});

test("unreachable host sampling preserves explicit unavailable diagnostics", async () => {
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", "127.0.0.1:1");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  const session = await startHostTelemetry([{ deviceId: 4, chipId: 0 }], "unused-fixture-path", new AbortController().signal);
  expect(session.targets).toMatchObject([{ deviceId: 4, chipId: 0, endpoint: null }]);
  expect(session.targets[0]?.errors.length).toBeGreaterThan(0);
  expect(await session.finish()).toEqual(session.targets);
});

test("cancelling during host startup closes the connection without waiting for readiness timeout", async () => {
  const controller = new AbortController();
  let disconnected = false;
  const server = createServer(socket => {
    socket.once("data", () => controller.abort());
    socket.on("end", () => { disconnected = true; });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  try {
    await expect(startHostTelemetry([{ deviceId: 4 }], "unused-fixture-path", controller.signal)).rejects.toThrow();
  } finally { await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
  expect(disconnected).toBe(true);
});

test.each(["local", "docker"] as const)("%s doctor checks only the host control channel without a sampling session", async environment => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-host-doctor-"));
  const operations: unknown[] = [];
  const server = createServer(socket => {
    socket.once("data", bytes => {
      const request = JSON.parse(bytes.toString()) as Record<string, unknown>;
      operations.push(request.op);
      expect(request.token).toBe("fixture-token");
      socket.end(JSON.stringify({ schemaVersion: 1, type: "pong" }) + "\n");
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  vi.stubEnv("AGENTX_DOCTOR_KEY", "fixture-secret");
  try {
    const file = join(root, "experiment.yaml");
    await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "http://127.0.0.1:18194/v1", api_key: "${AGENTX_DOCTOR_KEY}" } },
      benchmark: { name: "agentx", solver: { config: { telemetry: { ascend: { mode: "local", devices: [{ deviceId: 4 }] } } } } },
      environment }));
    const checks = await diagnose(await loadConfig(file, {}, process.env), file, AbortSignal.timeout(10000));
    expect(checks).toContainEqual(expect.objectContaining({ name: "NPU host sampling control (no device queries)", status: "passed" }));
    expect(operations).toEqual(["ping"]);
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { environment: "docker", outcome: "completed" }, { environment: "docker", outcome: "launch-failed" },
  { environment: "local", outcome: "completed" }, { environment: "local", outcome: "launch-failed" },
  { environment: "local", outcome: "cancelled" },
] as const)("$environment solver forwards host endpoints and releases sampling: $outcome", async ({ environment, outcome }) => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-host-solver-"));
  const tokenizer = join(root, "tokenizer"); await mkdir(tokenizer);
  await writeFile(join(tokenizer, "tokenizer.json"), "{}");
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await mkdir(paths.agent);
  const operations: unknown[] = [];
  const target = { deviceId: 4, chipId: 0, endpoint: telemetryConfig.ascend.endpoint, errors: [] };
  const server = createServer(socket => {
    let buffer = ""; socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, boundary)) as Record<string, unknown>;
        buffer = buffer.slice(boundary + 1); operations.push(message.op);
        socket.write(JSON.stringify({ schemaVersion: 1, type: message.op === "sample" ? "ready" : "finished", targets: [target] }) + "\n");
      }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_ADDRESS", `127.0.0.1:${address.port}`);
  vi.stubEnv("EVALUATOR_HOST_TELEMETRY_TOKEN", "fixture-token");
  const model = { name: "fixture-model", endpoint: "http://127.0.0.1:18194/v1", provider: null, api: "openai-completions" as const };
  const auth = { value: "fixture-secret", reference: null };
  const controller = new AbortController();
  const solver = new AgentXReplaySolver(parseAgentXReplayConfig({ tokenizer, cacheDir: join(root, "cache"),
    telemetry: { vllm: telemetryConfig.vllm, ascend: { mode: "local", devices: [{ deviceId: 4 }] } } }),
  { services: { default: { model, auth } }, solverService: "default", environmentName: environment, configDirectory: root, resolvePath: path => resolve(root, path) });
  const session: EnvironmentSession = {
    id: "task-container", workdir: "/workspace", agentOutputDir: "/logs/agent", verifierOutputDir: "/logs/verifier", metadata: {},
    ...(environment === "local" ? { runtime: { identity: "fixture-agentx", persistent: true, root: join(root, "runtime") } } : {}),
    async start(command) {
      const request = JSON.parse(Buffer.from(command.input ?? []).toString("utf8"));
      expect(request.hostAscend).toEqual([target]);
      expect(command.executable).toBe(environment === "docker" ? "/opt/agentx/bin/python" : join(root, "runtime", "venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python"));
      if (outcome === "launch-failed") throw new Error("controlled launch failure");
      if (outcome === "cancelled") controller.abort();
      return { stdout: Readable.from([Buffer.from(JSON.stringify({ schemaVersion: 1, type: "result", export: profileExport(), telemetry: serverMetricsEvidence() }) + "\n")]),
        stderr: Readable.from([]), done: Promise.resolve({ code: 0, signal: null }), async stop() {} };
    },
    async upload() {}, async download() {}, async restoreState() {}, async dispose() {},
    async exportState() { throw new Error("unused"); },
  };
  try {
    const promise = solver.solve({ id: "point", prompt: "AgentX", payload: workload }, session,
      { key: { runId: "run", taskId: "point", attemptId: "attempt" }, paths, signal: controller.signal });
    if (outcome === "launch-failed") await expect(promise).rejects.toThrow("controlled launch failure");
    else if (outcome === "cancelled") await expect(promise).rejects.toThrow();
    else expect((await promise).observations).toMatchObject({ telemetry: { sources: [expect.anything(), { kind: "ascend", deviceId: 4, status: "complete" }] } });
    expect(operations).toEqual(["sample", "finish"]);
    expect(JSON.parse(await readFile(join(paths.agent, "host-telemetry.json"), "utf8"))).toEqual({ localAscend: [target] });
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});
