import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { AttemptContext, AttemptKey, AttemptPaths, CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/index.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { verifyBundleCandidate } from "../../src/runtimes/agentbundle/sdk.js";
import { classifyError } from "../../src/core/errors/classify.js";
import { formatError } from "../../src/core/errors/diagnostics.js";
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { loadConfig } from "../../src/application/config.js";

const API_KEY = "app-dify-service-key";
const REPO_ROOT = resolve(import.meta.dirname ?? ".").includes("tests")
  ? resolve(join(import.meta.dirname ?? ".", "..", ".."))
  : process.cwd();
const fixture = join(REPO_ROOT, "tests/fixtures/agentbundle/dify");
const signal = new AbortController().signal;
const model = { name: "dify-internal-binding", endpoint: null, provider: null, api: null };
let solverSequence = 0;
let root: string;
let runtimeRoot: string;
let server: Server;
let baseUrl: string;
let requests: { method: string; path: string; authorization: string | null; body: string }[] = [];
let onImport: ((response: ServerResponse) => void) | undefined;

function sse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function workflowEvents(status: string, report: string, totalTokens: number): unknown[] {
  return [
    { event: "workflow_started", data: { id: "dify-run-1" } },
    { event: "node_finished", data: { id: "n1", index: 1, node_id: "solve", node_type: "llm", title: "solve", status: "succeeded", elapsed_time: 1.5, execution_metadata: { total_tokens: totalTokens } } },
    { event: "workflow_finished", data: { id: "dify-run-1", status, outputs: { report }, error: status === "succeeded" ? "" : `boom ${API_KEY}` } },
  ];
}

async function startServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization ?? null, body });
      if (req.url?.startsWith("/console/api/")) {
        if (req.url === "/console/api/apps/imports" && onImport) { onImport(res); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/console/api/apps/imports") res.end(JSON.stringify({ app_id: "app-installed-1" }));
        else if (req.url.endsWith("/api-keys")) res.end(JSON.stringify({ token: API_KEY }));
        else res.end("{}");
        return;
      }
      if (req.url === "/v1/workflows/run" && req.method === "POST") {
        if (body.includes("hang-workflow")) return;
        if (body.includes("transport-failure")) { res.destroy(); return; }
        const httpStatus = /http-status-(\d{3})/u.exec(body)?.[1];
        if (httpStatus) {
          res.writeHead(Number(httpStatus), { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "upstream-private-code", message: "request rejected" }));
          return;
        }
        if (body.includes("fail-me")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "bad", message: `endpoint exploded ${API_KEY}` }));
          return;
        }
        const status = body.includes("fail-status") ? "failed" : "succeeded";
        sse(res, workflowEvents(status, "report body", 123));
        return;
      }
      if (req.url === "/v1/hang") return; // never responds; the caller aborts
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function paths(name: string): Promise<AttemptPaths> {
  const base = join(root, name);
  const result = {
    root: base,
    agent: join(base, "agent"),
    verifier: join(base, "verifier"),
    artifacts: join(base, "artifacts"),
  };
  await Promise.all(Object.values(result).map(path => mkdir(path, { recursive: true })));
  return result;
}

/** Session that really spawns the requested command (the dify runner) — same seam as LocalEnvironment. */
function fakeSession(agentDir: string): EnvironmentSession {
  const start = async (command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> => {
    const child: ChildProcess = spawn(command.executable, command.args, { cwd: command.cwd, env: { ...process.env } });
    const runnerStdin = child.stdin;
    if (runnerStdin === null) throw new Error("spawned runner stdin unavailable");
    if (command.input !== null) runnerStdin.write(command.input);
    runnerStdin.end();
    const done = new Promise<{ code: number | null; signal: string | null }>(resolveDone => {
      child.on("close", (code, signal) => resolveDone({ code, signal: signal ?? null }));
    });
    signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    const runnerStdout = child.stdout;
    const runnerStderr = child.stderr;
    if (runnerStdout === null || runnerStderr === null) throw new Error("spawned runner stdio unavailable");
    return {
      stdout: runnerStdout,
      stderr: runnerStderr,
      done,
      async stop(graceMs: number) {
        child.kill("SIGTERM");
        await Promise.race([done, new Promise(resolveWait => setTimeout(resolveWait, graceMs))]);
      },
    };
  };
  return {
    id: "fake",
    workdir: root,
    agentOutputDir: agentDir,
    verifierOutputDir: root,
    metadata: { kind: "local" },
    runtime: { root: runtimeRoot, persistent: true, identity: "fixture-runtime" },
    start,
    async upload() {},
    async download() {},
    async exportState() { throw new Error("unused"); },
    async restoreState() {},
    async dispose() {},
  };
}

async function attemptContext(name: string): Promise<AttemptContext> {
  const key: AttemptKey = { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" };
  return { key, paths: await paths(name), signal: new AbortController().signal };
}

function makeSolver(options: { registryPath?: string; bundlePath?: string; baseUrl?: string } = {}): AgentBundleSolver {
  const registryPath = options.registryPath ?? join(root, `registry-${++solverSequence}.json`);
  return new AgentBundleSolver(options.bundlePath ?? fixture, model, { value: "unused-model-key", reference: null }, undefined, {
    dify: { baseUrl: options.baseUrl ?? baseUrl, registryPath },
  });
}

async function solve(solver: AgentBundleSolver, prompt: string, context: AttemptContext) {
  const prepared = await solver.prepare(fakeSession(context.paths.agent), context);
  try { return await prepared.solve({ id: "task-1", prompt }, context); }
  finally { await prepared.dispose?.(signal); }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "evaluator-agentbundle-dify-"));
  vi.stubEnv("DIFY_ADMIN_API_KEY", "controlled-admin-key");
  vi.stubEnv("DIFY_BASE", "http://wrong-service.invalid");
  await startServer();
  runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "dify"), { recursive: true });
  await copyFile(join(REPO_ROOT, "src/runtimes/dify/assets/runner.mjs"), join(runtimeRoot, "dify/runner.mjs"));
});

afterEach(() => { requests = []; onImport = undefined; });

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("AgentBundle Dify workflow", () => {
  test("solve maps the task prompt to inputs.task, runs the in-session runner, and collects evidence", async () => {
    const solver = makeSolver();
    const context = await attemptContext("success");
    const result = await solve(solver, "整理纪要", context);
    const workflows = requests.filter(request => request.path === "/v1/workflows/run");
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.path).toBe("/v1/workflows/run");
    expect(workflows[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    const payload = JSON.parse(workflows[0]?.body ?? "{}") as { inputs: { task: string }; response_mode: string };
    expect(payload.inputs.task).toBe("整理纪要");
    expect(payload.response_mode).toBe("streaming");
    expect(result.finalText).toBe("report body");
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: 123 });
    const trace = await readFile(join(context.paths.agent, "dify-run-trace.jsonl"), "utf8");
    const lines = trace.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: "dify-run-header", difyRunId: "dify-run-1", attempt: { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" } });
    expect(lines.at(-1)).toMatchObject({ kind: "dify-run-summary", difyRunId: "dify-run-1", status: "succeeded", totalTokens: 123 });
    expect(lines.filter(line => line["kind"] === "dify-node")).toHaveLength(1);

    const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
    const events = trajectory.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ seq: 1, type: "start", data: { solver: "agentbundle", harness: "dify" },
      key: { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" } });
    expect(events.at(-1)).toMatchObject({ type: "end", data: { status: "succeeded", totalTokens: 123 } });
    expect(events.map(event => event["seq"])).toEqual(events.map((_, index) => index + 1));
    const session = JSON.parse(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")) as Record<string, unknown>;
    expect(session).toMatchObject({ kind: "dify", difyRunId: "dify-run-1", appId: "app-installed-1" });
  });

  test("a failed workflow raises SOLVER_PROCESS_CRASHED with the key redacted and still writes evidence", async () => {
    const solver = makeSolver();
    const context = await attemptContext("failed-status");
    const error = await solve(solver, "fail-status", context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(EvaluatorError);
    expect((error as EvaluatorError).code).toBe("SOLVER_PROCESS_CRASHED");
    expect((error as Error).message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect((error as Error).message).toContain("[redacted]");
    const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
    const events = trajectory.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ type: "end", data: { status: "failed" } });
  });

  test("an HTTP failure raises MODEL_UNAVAILABLE with the key redacted", async () => {
    const solver = makeSolver();
    const context = await attemptContext("http-failure");
    const error = await solve(solver, "fail-me", context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(EvaluatorError);
    expect((error as EvaluatorError).code).toBe("MODEL_UNAVAILABLE");
    expect((error as Error).message).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  test.each([[401, "MODEL_AUTH_FAILED"], [429, "MODEL_RATE_LIMIT"], [400, "MODEL_REQUEST_INVALID"]])(
    "HTTP %s is sent as registered code %s", async (status, code) => {
      const context = await attemptContext(`http-${status}`);
      const error: unknown = await solve(makeSolver(), `http-status-${status}`, context).catch((value: unknown) => value);
      expect(error).toMatchObject({ code, details: { httpStatus: status } });
      expect(JSON.stringify(error)).not.toContain("upstream-private-code");
    },
  );

  test("transport errno is retained as evidence without becoming the runner error code", async () => {
    const context = await attemptContext("transport");
    const error: unknown = await solve(makeSolver(), "transport-failure", context).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(classifyError(error, { phase: "solve" }).details).toMatchObject({
      originalCode: expect.stringMatching(/^(?:UND_ERR_SOCKET|ECONNRESET)$/u), networkStage: "model-api",
    });
  });

  test("prepare returns a solver bound to the same execution", async () => {
    const solver = makeSolver();
    const context = await attemptContext("prepared");
    const prepared = await solver.prepare(fakeSession(context.paths.agent), context);
    try { expect((await prepared.solve({ id: "task-1", prompt: "整理纪要" }, context)).finalText).toBe("report body"); }
    finally { await prepared.dispose?.(signal); }
  });
});

describe("AgentBundle Dify preparation", () => {
  test("bootstrap resolves relative paths and rejects the removed solver registration", async () => {
    const configPath = join(root, "experiment.yaml");
    await writeFile(configPath, `services:\n  default:\n    model: dify-internal-binding\n    base_url: http://127.0.0.1:9/v1\n    api_key: \${KEY}\nbenchmark:\n  name: gsm8k\n  solver:\n    name: agentbundle\n    config:\n      path: ./bundle\n      dify:\n        baseUrl: ${baseUrl}\n        registryPath: ./bootstrap-registry.json\n`);
    await cp(fixture, join(root, "bundle"), { recursive: true });
    const loaded = await loadConfig(configPath, {}, { KEY: "unused-key" });
    const components = await bootstrap(loaded, root);
    try {
      expect(components.solver).toBeInstanceOf(AgentBundleSolver);
      const context = await attemptContext("bootstrap");
      await (await components.solver.prepare?.(fakeSession(context.paths.agent), context))?.dispose?.(signal);
      expect(await readFile(join(root, "bootstrap-registry.json"), "utf8")).toContain("app-installed-1");
    } finally { await components.dispose(); }
    loaded.experiment.solver = { name: "dify", service: "default", config: {} };
    await expect(bootstrap(loaded, root)).rejects.toThrow(/dify/);
  });

  test("requires Dify options for Dify bundles and rejects them on another harness", async () => {
    await expect(new AgentBundleSolver(fixture, model, { value: "", reference: null }).provenance(signal))
      .rejects.toThrow(/agentbundle.dify.baseUrl/);
    await expect(makeSolver({ bundlePath: join(REPO_ROOT, "tests/fixtures/agentbundle/hermes") }).provenance(signal))
      .rejects.toThrow(/only accepted for Dify/);
    expect(requests).toHaveLength(0);
  });

  test("cancels an in-flight SDK request, releases the registry lock and allows a later attempt", async () => {
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    onImport = response => { response.on("close", () => closed.resolve()); arrived.resolve(); };
    const registryPath = join(root, "cancel-install-registry.json");
    const solver = makeSolver({ registryPath });
    const context = await attemptContext("cancel-install");
    const controller = new AbortController();
    const flight = solver.prepare(fakeSession(context.paths.agent), { ...context, signal: controller.signal });
    const rejected = expect(flight).rejects.toMatchObject({ name: "AbortError" });
    await arrived.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    onImport = undefined;
    await (await solver.prepare(fakeSession(context.paths.agent), context)).dispose?.(signal);
    expect(requests.filter(request => request.path.endsWith("/workflows/publish"))).toHaveLength(1);
  });

  test("does not retry a failed Console write and redacts its error and cause", async () => {
    onImport = response => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "failed with controlled-admin-key" }));
    };
    const context = await attemptContext("install-failure");
    const error: unknown = await makeSolver().prepare(fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
    expect(formatError(error)).not.toContain("controlled-admin-key");
    expect(formatError(error)).toContain("[redacted]");
    expect(requests).toHaveLength(1);
  });

  test("stops a malformed runner and redacts stderr and protocol error causes", async () => {
    const context = await attemptContext("bad-protocol");
    const session = fakeSession(context.paths.agent);
    let stops = 0;
    session.start = async () => {
      async function* stdout() { yield Buffer.from(`${API_KEY}\n`); }
      async function* stderr() { yield Buffer.from(`stderr ${API_KEY}`); }
      return { stdout: stdout(), stderr: stderr(), done: Promise.resolve({ code: 1, signal: null }), async stop() { stops++; } };
    };
    const prepared = await makeSolver().prepare(session, context);
    try {
      const error: unknown = await prepared.solve({ id: "task-1", prompt: "text" }, context).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
      expect(formatError(error)).not.toContain(API_KEY);
      expect(await readFile(join(context.paths.agent, "runner-stderr.log"), "utf8")).toBe("stderr [redacted]");
      expect(stops).toBe(1);
    } finally { await prepared.dispose?.(signal); }
  });

  test("locks bundle and runner provenance without probing or installing a remote app", async () => {
    const solver = makeSolver();
    const provenance = await solver.provenance(signal);
    expect(provenance).toMatchObject({ harness: "dify", runnerVersion: "2", harnessVersionRange: ">=1.17 <2",
      bundle: (await verifyBundleCandidate(fixture)).digest, installation: expect.stringMatching(/^dify:/) });
    expect(provenance.harnessVersion).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(solver.requirements()).toEqual([{ name: "node", version: "24.x", platform: "any" }]);
    const runtime = await solver.runtimeInstallation(signal);
    expect(runtime.id).toBe(provenance.installation);
    expect(runtime.files).toEqual([expect.objectContaining({ target: "dify/runner.mjs" })]);
  });

  test("parallel attempts share one remote installation and write credential-free evidence", async () => {
    const solver = makeSolver();
    await solver.provenance(signal);
    const contexts = await Promise.all([attemptContext("parallel-1"), attemptContext("parallel-2")]);
    const prepared = await Promise.all(contexts.map(context => solver.prepare(fakeSession(context.paths.agent), context)));
    expect(requests.filter(request => request.path === "/console/api/apps/imports")).toHaveLength(1);
    expect(requests.filter(request => request.path.endsWith("/api-keys"))).toHaveLength(1);
    expect(requests.every(request => request.authorization === "Bearer controlled-admin-key")).toBe(true);
    for (const context of contexts) {
      const evidence = await readFile(join(context.paths.agent, "installation.json"), "utf8");
      expect(JSON.parse(evidence)).toMatchObject({ harness: { name: "dify" }, appId: "app-installed-1" });
      expect(evidence).not.toContain(API_KEY);
      expect(evidence).not.toContain("controlled-admin-key");
    }
    await Promise.all(prepared.map(async (handle, index) => {
      const context = contexts[index];
      if (!context) throw new Error("missing context");
      try {
        expect((await handle.solve({ id: "task-1", prompt: "text" }, context)).finalText).toBe("report body");
        await expect(handle.solve({ id: "task-1", prompt: "again" }, context)).rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
      } finally { await handle.dispose?.(signal); }
    }));
  });

  test("a changed bundle after provenance fails before installation", async () => {
    const bundlePath = join(root, "changed-bundle");
    await cp(fixture, bundlePath, { recursive: true });
    const solver = makeSolver({ bundlePath });
    await solver.provenance(signal);
    await writeFile(join(bundlePath, "workflow.yaml"), "kind: app\nchanged: true\n");
    const context = await attemptContext("changed");
    await expect(solver.prepare(fakeSession(context.paths.agent), context)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(requests).toHaveLength(0);
  });

  test("does not reuse an installation from another service", async () => {
    const registryPath = join(root, "foreign-registry.json");
    const context = await attemptContext("foreign");
    const prepared = await makeSolver({ registryPath }).prepare(fakeSession(context.paths.agent), context);
    await prepared.dispose?.(signal);
    requests = [];
    await expect(makeSolver({ registryPath, baseUrl: "http://other-service.invalid" }).prepare(fakeSession(context.paths.agent), context))
      .rejects.toThrow(/different service/);
    expect(requests).toHaveLength(0);
  });

  test("reused installations need no Console credentials and reject a missing Service API key", async () => {
    const registryPath = join(root, "reuse-registry.json");
    const context = await attemptContext("reuse");
    await (await makeSolver({ registryPath }).prepare(fakeSession(context.paths.agent), context)).dispose?.(signal);
    const previous = process.env.DIFY_ADMIN_API_KEY;
    delete process.env.DIFY_ADMIN_API_KEY;
    try {
      requests = [];
      await (await makeSolver({ registryPath }).prepare(fakeSession(context.paths.agent), context)).dispose?.(signal);
      expect(requests).toHaveLength(0);
      const records: Record<string, unknown>[] = JSON.parse(await readFile(registryPath, "utf8"));
      for (const record of records) delete record.apiKey;
      await writeFile(registryPath, JSON.stringify(records));
      await expect(makeSolver({ registryPath }).prepare(fakeSession(context.paths.agent), context)).rejects.toMatchObject({ code: "MODEL_AUTH_FAILED" });
    } finally { process.env.DIFY_ADMIN_API_KEY = previous; }
  });

  test("disposing a running attempt stops the runner and preserves cancellation", async () => {
    const context = await attemptContext("cancel");
    const prepared = await makeSolver().prepare(fakeSession(context.paths.agent), context);
    const flight = prepared.solve({ id: "task-1", prompt: "hang-workflow" }, context);
    const rejected = expect(flight).rejects.toMatchObject({ name: "AbortError" });
    await prepared.dispose?.(signal);
    await rejected;
    await expect(prepared.solve({ id: "task-1", prompt: "after-dispose" }, context)).rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
  });

  test("Docker execution uses POSIX runner paths without uploading a bundle", async () => {
    const context = await attemptContext("docker");
    let command: CommandSpec | undefined;
    const session = fakeSession(context.paths.agent);
    session.runtime = { root: "/opt/evaluator-agent", identity: "docker-runtime", persistent: false };
    session.workdir = "/workspace";
    session.start = async spec => {
      command = spec;
      async function* stdout() { yield Buffer.from(JSON.stringify({ schemaVersion: 1, type: "result", result: { finalText: "docker", usage: { inputTokens: null, outputTokens: null, totalTokens: null } } }) + "\n"); }
      async function* stderr() {}
      return { stdout: stdout(), stderr: stderr(), done: Promise.resolve({ code: 0, signal: null }), async stop() {} };
    };
    const prepared = await makeSolver().prepare(session, context);
    try {
      expect((await prepared.solve({ id: "task-1", prompt: "text" }, context)).finalText).toBe("docker");
      expect(command).toMatchObject({ executable: "node", args: ["/opt/evaluator-agent/dify/runner.mjs"], inheritEnv: false, env: {} });
    } finally { await prepared.dispose?.(signal); }
  });
});
