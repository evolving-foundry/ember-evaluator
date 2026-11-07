import "../fixtures/network-fetch.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { expectRecord } from "../../src/core/validation/input.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentXBenchmark, parseAgentXConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/agentx-benchmark.js";
import { AgentXPerformanceMetrics } from "../../src/plugins/metrics/agentx-performance.js";
import { normalizeAgentXExport } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { lockAgentXLexicon } from "../../src/runtimes/agentx/runtime.js";
import { runEngine } from "../../src/application/run-engine.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { saveReport, rebuildReport } from "../../src/application/report/index.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { storeRun } from "../fixtures/results/store-fixture.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { workload, lexicon, profileExport } from "../fixtures/agentx/export.js";
import type { SourceLock, TaskRef } from "../../src/core/contracts/task.js";
import { EvaluatorError } from "../../src/core/errors/evaluator-error.js";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { validateTransferSpec } from "../../src/infrastructure/filesystem/workspace-transfer.js";
import { normalizeTelemetry, type AgentXTelemetry } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { serverMetricsEvidence, telemetryConfig } from "../fixtures/agentx/server-metrics.js";

const cleanup: (() => Promise<void>)[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => { vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function root() {
  await mkdir(".scratch", { recursive: true });
  const path = await mkdtemp(join(".scratch", "agentx-test-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

test.each([60, 3600])("HF source locks exact bytes and passes the %s-second window to measurement points", async durationSeconds => {
  const cacheDir = await root();
  const bytes = '{"id":"controlled-trace"}\n';
  const digest = createHash("sha256").update(bytes).digest("hex");
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ sha: "a".repeat(40), siblings: [{ rfilename: "traces.jsonl", lfs: { sha256: digest } }] }));
    } else response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
  vi.stubEnv("HF_ENDPOINT", `http://127.0.0.1:${address.port}`);
  const benchmark = new AgentXBenchmark(parseAgentXConfig({ concurrency: [1, 8], cacheDir, durationSeconds }), "local");
  const lock = await benchmark.resolveSource(null, signal());
  expect(lock.revision).toBe("a".repeat(40));
  expect(lock.files[0]?.sha256).toBe(digest);
  expect(await benchmark.resolveSource(lock, signal())).toEqual(lock);
  const refs: TaskRef[] = [];
  for await (const ref of benchmark.enumerate(lock, signal())) refs.push(ref);
  expect(refs.map(ref => ref.id)).toEqual(["agentx-256k-standard-c1", "agentx-256k-standard-c8"]);
  const plan = await benchmark.planRun(refs, lock, signal());
  expect(plan.tasks[1]?.input.payload).toMatchObject({ concurrency: 8, durationSeconds, sha256: digest, tracePath: "input/traces.jsonl" });
  expect(await readFile(plan.tasks[0]?.solveEnv.initialFiles[0]?.source ?? "", "utf8")).toBe(bytes);
  const dockerPlan = await new AgentXBenchmark(benchmark.config, "docker").planRun(refs, lock, signal());
  expect(dockerPlan.tasks[0]?.solveEnv.network).toBe("host");
  for (const task of dockerPlan.tasks) {
    const collection = task.artifactCollection;
    if (!collection) throw new Error("AgentX must collect Harness artifacts");
    expect(() => validateTransferSpec(collection, "/workspace")).not.toThrow();
    expect(collection).toEqual({ kind: "artifacts", workdir: "/workspace", paths: ["/workspace/agentx-artifacts"] });
  }
  expect(plan.tasks[0]?.artifactCollection).toEqual({ kind: "artifacts", workdir: ".", paths: ["agentx-artifacts"] });
  const task = plan.tasks[0]; if (!task) throw new Error("task fixture");
  const summary = normalizeAgentXExport(profileExport(), { ...workload, durationSeconds, sha256: digest }, lexicon);
  expect(await benchmark.verify(task, { finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: summary }, null, signal())).toMatchObject({ passed: null });
  await expect(benchmark.verify(task, { finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: { ...summary, workload: { ...summary.workload, concurrency: 8 } } }, null, signal())).rejects.toThrow(/locked measurement point/);
});

test("tokenizer resume reuses its pinned revision, and content changes alter its identity", async () => {
  const path = await root();
  const directory = join(path, "tokenizer"); await mkdir(directory);
  await writeFile(join(directory, "tokenizer.json"), "first");
  const resolve = (name: string) => join(path, name);
  const first = await lockAgentXLexicon("tokenizer", undefined, join(path, "cache"), resolve, signal());
  expect(first.revision).toBe("local");
  await writeFile(join(directory, "tokenizer.json"), "changed");
  const second = await lockAgentXLexicon("tokenizer", undefined, join(path, "cache"), resolve, signal());
  expect(second.digest).not.toBe(first.digest);
  expect(await readFile(join(first.path, "tokenizer.json"), "utf8")).toBe("first");
});

test("performance payload survives public projection; timeout remains incomplete and resume restarts it", async () => {
  const path = await root(), value = harness(path);
  cleanup.push(() => value.dispose());
  value.components.benchmark = { ...value.components.benchmark, evaluationKind: "performance" };
  const prepare = value.components.benchmark.prepare.bind(value.components.benchmark);
  value.components.benchmark.prepare = async (...args) => {
    const task = await prepare(...args);
    return { ...task, input: { ...task.input, payload: { concurrency: 8 } }, phaseTimeoutSeconds: { solve: 0.05 } };
  };
  value.components.benchmark.verify = async () => ({ passed: null, details: {} });
  value.config.experiment.run.taskIds = ["a"];
  value.config.experiment.run.timeoutSeconds = 1;
  value.components.solver.solve = async (input, _session, context) => {
    expect(input).toEqual({ id: "a", prompt: "Public question", payload: { concurrency: 8 } });
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
    throw new Error("unreachable");
  };
  const result = await runEngine({ ...value, signal: signal() });
  expect(result.run.evaluationKind).toBe("performance");
  expect(result.records[0]).toMatchObject({ scoreStatus: "not-applicable", executionStatus: "failed", verdict: null });
  expect(planResume(result.run, await value.components.store.listAttempts(), result.run.configFingerprint).restartTaskIds).toEqual(["a"]);
  value.components.solver.solve = async () => ({ finalText: "measured", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: {} });
  await value.components.store.close();
  value.config.experiment.run.timeoutSeconds = 1;
  const resumed = await runEngine({ ...value, signal: signal(), resumeDirectory: join(value.config.experiment.output.directory, result.run.runId) });
  expect(resumed.records[0]).toMatchObject({ executionStatus: "completed", scoreStatus: "not-applicable", verdict: { passed: null } });
  expect(planResume(resumed.run, await value.components.store.listAttempts(), resumed.run.configFingerprint).restartTaskIds).toEqual([]);
});

test.each(["none", "v1", "v2", "custom-duration"] as const)("offline reporting reproduces saved AgentX %s metrics without loading Python or credentials", async version => {
  const path = await root(), value = harness(path);
  cleanup.push(() => value.dispose());
  value.components.benchmark = { ...value.components.benchmark, evaluationKind: "performance" };
  value.components.benchmark.verify = async () => ({ passed: null, details: {} });
  const solve = value.components.solver.solve.bind(value.components.solver);
  const summary = normalizeAgentXExport(profileExport(), { ...workload, durationSeconds: version === "custom-duration" ? 60 : 3600 }, lexicon);
  if (version !== "none" && version !== "custom-duration") {
    const telemetry: AgentXTelemetry = normalizeTelemetry(telemetryConfig, "fixture-model", serverMetricsEvidence());
    if (version === "v2") {
      const hardware = telemetry.sources.find(source => source.kind === "ascend");
      if (!hardware) throw new Error("fixture hardware");
      const second = structuredClone(hardware);
      second.deviceId = 5;
      second.endpoint = "http://127.0.0.1:18096/metrics";
      for (const series of [...second.series, ...second.warmupSeries]) series.labels.device_id = "5";
      telemetry.sources.push(second);
    }
    summary.telemetry = telemetry;
  }
  value.components.solver.solve = async (...args) => ({ ...await solve(...args), observations: summary });
  const locked: SourceLock = { ...source, revision: workload.revision,
    files: [{ path: "traces.jsonl", origin: "https://fixture.invalid/traces", sha256: workload.sha256 }] };
  await value.components.store.create(join(path, "runs"), { ...storeRun, source: locked, taskIds: ["a"], evaluationKind: "performance" },
    { metrics: [{ name: "agentx-performance", config: {} }], reporter: { name: "markdown", config: {} } });
  const job = { runId: "run-1", taskId: "a", attemptId: "attempt-1", ref: { id: "a", recordKey: "a" }, configFingerprint: "config-hash" };
  const record = await runTask(job, value.components, locked, signal());
  expect(record.executionStatus).toBe("completed");
  await value.components.store.updateRun({ status: "completed", finishedAt: new Date().toISOString(), durationMs: 1000 });
  if (version === "v1") {
    // Simulate an existing saved file; current Solver output remains v2.
    const saved = structuredClone(record);
    const observations = expectRecord(saved.solve?.observations, "saved observations");
    expectRecord(observations.telemetry, "saved telemetry").schemaVersion = 1;
    await writeFile(join(path, "runs", "run-1", "tasks", safeTaskKey("a"), "attempts", "attempt-1", "result.json"), JSON.stringify(saved));
  }
  await saveReport(value.components.store, [new AgentXPerformanceMetrics()], new MarkdownReporter());
  const directory = join(path, "runs", "run-1");
  const originalMetrics = await readFile(join(directory, "metrics.json"), "utf8");
  const originalReport = await readFile(join(directory, "report.md"), "utf8");
  await value.components.store.close();
  vi.stubEnv("MODEL_API_KEY", undefined); vi.stubEnv("PYTHON_BIN", "missing-python");
  await rebuildReport(directory);
  expect(await readFile(join(directory, "metrics.json"), "utf8")).toBe(originalMetrics);
  expect(await readFile(join(directory, "report.md"), "utf8")).toBe(originalReport);
  expect(originalReport).not.toContain("fixture-key");
  expect(originalReport).not.toContain("| agentx-performance |");
  if (version === "v2") expect(originalReport).toContain("#### NPU 5 / chip 0");
  if (version === "custom-duration") {
    expect(summary.comparable).toBe(false);
    expect(originalReport).toContain("custom\\_duration");
  }
});

test("an explicit Agent timeout code still cannot create a zero-scored performance result", async () => {
  const path = await root(), value = harness(path);
  cleanup.push(() => value.dispose());
  value.components.benchmark = { ...value.components.benchmark, evaluationKind: "performance" };
  value.components.benchmark.verify = async () => ({ passed: null, details: {} });
  value.components.solver.solve = async () => { throw new EvaluatorError("SOLVER_AGENT_TIMEOUT", "controlled timeout"); };
  value.config.experiment.run.taskIds = ["a"];
  const result = await runEngine({ ...value, signal: signal() });
  expect(result.records[0]).toMatchObject({ executionStatus: "failed", scoreStatus: "not-applicable", verdict: null });
});

test("dry-run rejects overlapping measurement points before source or Python I/O", async () => {
  const path = await root(), file = join(path, "invalid.yaml");
  await writeFile(file, stringify({ services: { default: { model: "fixture/model", base_url: "http://localhost:8000", api_key: "${AGENTX_TEST_KEY}" } },
    benchmark: "agentx", scheduler: { name: "local", concurrency: 2 } }));
  vi.stubEnv("AGENTX_TEST_KEY", "controlled-key");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected source I/O"));
  const messages: string[] = [];
  try {
    expect(await runCli(["run", file, "--dry-run"], { out: line => { messages.push(line); }, error: line => { messages.push(line); } })).not.toBe(0);
    expect(messages.join("\n")).toContain("scheduler concurrency=1");
    expect(fetch).not.toHaveBeenCalled();
    expect(messages.join("\n")).not.toContain("controlled-key");
  } finally { fetch.mockRestore(); }
});

test.each(["local", "docker"])("dry-run accepts %s host NPU sampling without starting a sampling session", async environment => {
  const path = await root(), file = join(path, "local-telemetry-docker.yaml");
  await writeFile(file, stringify({ services: { default: { model: "fixture/model", base_url: "http://localhost:8000", api_key: "${AGENTX_TEST_KEY}" } },
    benchmark: { name: "agentx", solver: { config: { telemetry: { ascend: { mode: "local", devices: [{ deviceId: 4 }] } } } } },
    environment }));
  vi.stubEnv("AGENTX_TEST_KEY", "controlled-key");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected source I/O"));
  const messages: string[] = [];
  try {
    expect(await runCli(["run", file, "--dry-run"], { out: line => { messages.push(line); }, error: line => { messages.push(line); } })).not.toBe(0);
    expect(messages.join("\n")).not.toContain("Local Ascend telemetry requires environment=local");
    expect(fetch).toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

test("AgentX Trace preparation uses the explicit token rather than the process token", async () => {
  const path = await root(); const body = "controlled trace bytes";
  const authorizations: string[] = [];
  const server = createServer((request, response) => { authorizations.push(request.headers.authorization ?? ""); response.end(body); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
  vi.stubEnv("HF_TOKEN", "unrelated-process-token");
  const dataset = "semianalysisai/cc-traces-weka-062126-256k";
  const lock: SourceLock = { source: "controlled-agentx", revision: "a".repeat(40), metadata: { dataset },
    files: [{ path: "traces.jsonl", origin: `http://127.0.0.1:${address.port}/traces.jsonl`, sha256: createHash("sha256").update(body).digest("hex") }] };
  const benchmark = new AgentXBenchmark(parseAgentXConfig({ cacheDir: join(path, "cache"), hfToken: "explicit-trace-token" }), "local",
    { async resolve() { return lock; }, async *rows() {} });
  const task = await benchmark.prepare({ id: "agentx-256k-standard-c1", recordKey: { concurrency: 1 } }, lock, signal());
  expect(authorizations).toEqual(["Bearer explicit-trace-token"]);
  expect(JSON.stringify(task)).not.toContain("explicit-trace-token");
});

test("remote tokenizer resume uses the original commit after main has advanced", async () => {
  const path = await root();
  let head = "a".repeat(40);
  const oldBytes = '{"version":"original"}', newBytes = '{"version":"updated"}';
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    if (request.url?.startsWith("/api/models/")) {
      const revision = request.url.includes("/revision/main") ? head : "a".repeat(40);
      const bytes = revision === "a".repeat(40) ? oldBytes : newBytes;
      response.end(JSON.stringify({ sha: revision, siblings: [{ rfilename: "tokenizer.json",
        lfs: { sha256: createHash("sha256").update(bytes).digest("hex") } }] }));
    } else response.end(request.url?.includes("/resolve/" + "a".repeat(40)) ? oldBytes : newBytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
  vi.stubEnv("HF_ENDPOINT", `http://127.0.0.1:${address.port}`);
  const resolvePath = (name: string) => join(path, name);
  const first = await lockAgentXLexicon("fixture/tokenizer", undefined, join(path, "cache"), resolvePath, signal());
  head = "b".repeat(40);
  const resumed = await lockAgentXLexicon("fixture/tokenizer", undefined, join(path, "cache"), resolvePath, signal(), { lexiconRevision: first.revision });
  expect(resumed.revision).toBe(first.revision);
  expect(resumed.digest).toBe(first.digest);
  expect(requested).toContain(`/api/models/fixture/tokenizer/revision/${first.revision}?blobs=true`);
  const fresh = await lockAgentXLexicon("fixture/tokenizer", undefined, join(path, "cache"), resolvePath, signal());
  expect(fresh.revision).toBe(head);
  expect(fresh.digest).not.toBe(first.digest);
});

test.each([
  { name: "process failure", code: 1, terminal: { schemaVersion: 1, type: "error" } },
  { name: "missing export", code: 0, terminal: { schemaVersion: 1, type: "result" } },
])("$name rejects the measurement, redacts diagnostics and keeps partial artifacts", async ({ code, terminal }) => {
  const path = resolve(await root()), directory = join(path, "tokenizer");
  await mkdir(directory); await writeFile(join(directory, "tokenizer.json"), "controlled-tokenizer");
  const paths = { root: path, agent: join(path, "agent"), verifier: join(path, "verifier"), artifacts: join(path, "artifacts") };
  const session = await new LocalEnvironment(path).prepare({ workdir: ".", image: null, initialFiles: [], runtime: [] }, paths, "solve", signal());
  cleanup.push(() => session.dispose(signal()));
  const stop = vi.fn(async () => {});
  async function* stream(text: string) { yield Buffer.from(text); }
  session.start = async () => {
    await mkdir(join(session.workdir, "agentx-artifacts"));
    await writeFile(join(session.workdir, "agentx-artifacts", "harness.log"), "controlled partial evidence");
    return { stdout: stream(JSON.stringify(terminal)), stderr: stream("error for fixture-secret"),
      done: Promise.resolve({ code, signal: null }), stop };
  };
  const model = { name: "fixture/model", endpoint: "http://localhost:8000", api: "openai-completions", provider: null };
  const auth = { value: "fixture-secret", reference: null };
  // The session's process protocol is controlled; this does not invoke Docker or Python.
  const solver = new AgentXReplaySolver(parseAgentXReplayConfig({ tokenizer: directory, cacheDir: join(path, "cache") }),
    { services: { default: { model, auth } }, solverService: "default", environmentName: "docker",
      configDirectory: path, resolvePath: name => resolve(path, name) });
  await expect(solver.solve({ id: "point", prompt: "", payload: workload }, session,
    { key: { runId: "run", taskId: "point", attemptId: "attempt" }, paths, signal: signal() })).rejects.toThrow();
  expect(stop).toHaveBeenCalledWith(500);
  const diagnostic = await readFile(join(paths.agent, "bridge-stderr.log"), "utf8");
  expect(diagnostic).not.toContain(auth.value);
  expect(diagnostic).toContain("[redacted]");
  await expect(readFile(join(paths.agent, "agentx-summary.json"))).rejects.toThrow();
  const target = join(paths.artifacts, "partial.tar");
  await session.exportState({ kind: "artifacts", workdir: ".", paths: ["agentx-artifacts"] }, target, signal());
  await session.dispose(signal());
  expect((await readFile(target)).length).toBeGreaterThan(0);
});
