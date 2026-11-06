import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { writeFile } from "node:fs/promises";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";
import { normalizeAgentXExport, parseAgentXSummary, parseWorkload } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { loadConfig } from "../../src/application/config.js";
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { runEngine } from "../../src/application/run-engine.js";
import { rebuildReport, saveReport } from "../../src/application/report/index.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { normalizeTelemetry, parseTelemetryConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { parseNetworkLatencyConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/network-latency.js";

// Opt-in: default tests neither install Python packages nor download tokenizers.
const python = process.env.AGENTX_TEST_PYTHON;

test.skipIf(!python).each(["automatic", "manual"])("real AgentX exports raw and RTT-adjusted latencies with %s calibration", async mode => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-network-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), `--network-${mode}`], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) }, undefined,
      { config: parseNetworkLatencyConfig(value.networkLatencyConfig), probes: value.networkLatencyProbes });
    expect(summary.networkLatency?.status).toBe("complete");
    expect(summary.networkLatency?.rttMs).toBeGreaterThan(0);
    expect(summary.networkLatency?.adjusted.ttft?.mean).toBe(value.raw.network_adjusted_time_to_first_token.avg);
    expect(summary.profiling.ttft?.mean).toBe(value.raw.time_to_first_token.avg);
    expect(parseAgentXSummary(summary)).toEqual(summary);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);
test.skipIf(!python).each([false, true])("real AgentX preserves phase metrics, counter resets and collection failures (failure=%s)", async failure => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-real-telemetry-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--full-replay", "--telemetry", ...(failure ? ["--telemetry-error"] : [])], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const telemetry = normalizeTelemetry(parseTelemetryConfig(value.telemetryConfig), "fixture-model", value.telemetry);
    expect(telemetry.sources.map(s => s.status), JSON.stringify(telemetry)).toEqual(["complete", "complete"]);
    if (failure) expect(telemetry.collectionErrors).toBeGreaterThan(0);
    else expect(telemetry.collectionErrors).toBe(0);
    const counter = telemetry.sources[0]?.series.find(s => s.metric === "vllm:num_preemptions");
    expect(counter?.total).toBeGreaterThan(0);
    expect(counter?.total).toBeLessThan(500);
    expect(telemetry.sources.every(s => s.samples > 0)).toBe(true);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);
test.skipIf(!python)("full replay covers the first selected traces and their child requests exactly once", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-full-replay-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--full-replay"], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) }, value.replayCoverage);
    expect(summary.replayCoverage).toMatchObject({ selectedTraces: 3, completedTraces: 3, expectedRequests: 21, observedRequests: 21, complete: true });
    expect(summary.profiling.requests?.mean).toBe(21);
    expect(summary.workload.durationSeconds).toBe(1800);
    expect(summary.upstreamInvalidReasons).not.toContain("insufficient_profile_metric_coverage");
    expect(summary.comparable).toBe(false);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);

test.skipIf(!python).each([false, true])("real AgentX loads the locked corpus and starts smoke lanes together (concurrency check=%s)", async concurrency => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-real-"));
  const handle = await startLocalProcess({ executable: python ?? "python",
    args: [resolve("tests/fixtures/agentx/check-bridge.py"), root, resolve("src/runtimes/agentx/assets/runner.py"), ...(concurrency ? ["--smoke-concurrency"] : [])],
    cwd: resolve("."), env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    expect(value.requests).toBeGreaterThan(0);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) });
    expect(summary.profiling.requests?.mean).toBeGreaterThan(0);
    if (concurrency) expect(summary.profiling.requests?.mean).toBeGreaterThanOrEqual(4);
    expect(summary.comparable).toBe(false);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);

test.skipIf(!python)("Evaluator runs a 60-second YAML window through the real Harness and collects its raw artifacts", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-e2e-"));
  const helper = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--serve", "--standard-duration"], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const diagnostics = (async () => { for await (const _chunk of helper.stderr) { /* Drain tokenizer diagnostics. */ } })();
  let components: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let passed = false;
  try {
    const readiness = async () => {
      let buffered = "";
      for await (const chunk of helper.stdout) {
        buffered += Buffer.from(chunk).toString("utf8");
        for (const line of buffered.split(/\r?\n/u)) {
          if (line.trim().startsWith("{") && line.trim().endsWith("}")) return JSON.parse(line);
        }
      }
      throw new Error("Controlled server ended before readiness");
    };
    const ready = await readiness();
    vi.stubEnv("HF_ENDPOINT", ready.url);
    const configPath = join(root, "experiment.yaml");
    await writeFile(configPath, stringify({ services: { default: { model: "fixture-model", base_url: ready.url, api_key: "${AGENTX_FIXTURE_KEY}" } },
      benchmark: { name: "agentx", scenario: "standard", config: { cacheDir: join(root, "cache"), durationSeconds: 60 },
        solver: { config: { tokenizer: ready.tokenizer, pythonExecutable: python, cacheDir: join(root, "cache"), requestTimeoutSeconds: 10,
          networkLatency: { mode: "automatic", pingIntervalSeconds: 0.2 } } } },
      environment: "local", output: { directory: join(root, "runs") } }));
    const config = await loadConfig(configPath, {}, { ...process.env, AGENTX_FIXTURE_KEY: ready.key });
    components = await bootstrap(config, root);
    // Use the already installed, pinned test interpreter. The real installer
    // recipe is exercised when preparing the validation environment separately.
    const runtime = join(root, "runtime"); await mkdir(runtime);
    await cp(resolve("src/runtimes/agentx/assets"), join(runtime, "bridge"), { recursive: true });
    await symlink(dirname(dirname(resolve(python ?? "python"))), join(runtime, "venv"), process.platform === "win32" ? "junction" : "dir");
    components.solver.runtimeInstallation = async () => ({ id: "agentx-controlled-runtime", files: [], commands: [], probes: [], localRoot: runtime });
    const snapshot = await runEngine({ components, config, signal: AbortSignal.timeout(90000) });
    expect(snapshot.run.status, JSON.stringify(snapshot.records[0]?.errors)).toBe("completed");
    const record = snapshot.records[0]; if (!record) throw new Error("No measurement saved");
    expect(record).toMatchObject({ executionStatus: "completed", evaluationKind: "performance", scoreStatus: "not-applicable",
      verdict: { passed: null }, collection: { artifacts: "complete", trajectory: "complete" } });
    expect(record.verdict).not.toHaveProperty("score");
    const summary = parseAgentXSummary(record.solve?.observations);
    expect(summary.workload).toMatchObject({ mode: "standard", durationSeconds: 60 });
    expect(summary.warmup.requests?.mean).toBe(11);
    expect(summary.profiling.duration?.mean).toBeGreaterThanOrEqual(55);
    expect(summary.profiling.duration?.mean).toBeLessThan(75);
    expect(summary.comparable).toBe(false);
    expect(summary.incomparableReasons).toContain("custom_duration");
    expect(summary.networkLatency?.status).toBe("complete");
    expect(summary.networkLatency?.probes?.successful).toBeGreaterThan(0);
    const archive = join(config.experiment.output.directory, snapshot.run.runId, "tasks", safeTaskKey(record.key.taskId),
      "attempts", record.key.attemptId, "artifacts", "artifacts.tar");
    expect((await stat(archive)).size).toBeGreaterThan(0);
    await saveReport(components.store, components.metrics, components.reporter);
    const runDirectory = join(config.experiment.output.directory, snapshot.run.runId);
    const report = await readFile(join(runDirectory, "report.md"), "utf8");
    expect(report).toContain("#### 网络延时校准");
    expect(report).toContain("TTFT 扣除 RTT 后");
    await components.store.close();
    await rebuildReport(runDirectory);
    expect(await readFile(join(runDirectory, "report.md"), "utf8")).toBe(report);
    const controller = new AbortController();
    const running = runEngine({ components, config, signal: controller.signal });
    void running.catch(() => {});
    let childPid: number | undefined;
    await vi.waitFor(async () => {
      if (!components) throw new Error("Missing fixture components");
      const attempts = await components.store.listAttempts();
      const attempt = attempts[0]; if (!attempt) throw new Error("Waiting for attempt allocation");
      const trajectory = join(config.experiment.output.directory, attempt.key.runId, "tasks", safeTaskKey(attempt.key.taskId),
        "attempts", attempt.key.attemptId, "agent", "trajectory.jsonl");
      const events = (await readFile(trajectory, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      childPid = events.find(event => event.type === "harness")?.data.pid;
      expect(childPid).toBeTypeOf("number");
    }, { timeout: 20000, interval: 30 });
    controller.abort(new DOMException("Controlled cancellation", "AbortError"));
    const cancelled = await running;
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.records[0]).toMatchObject({ executionStatus: "cancelled", scoreStatus: "not-applicable", verdict: null });
    expect(planResume(cancelled.run, await components.store.listAttempts(), cancelled.run.configFingerprint).restartTaskIds).toEqual(cancelled.run.taskIds);
    if (childPid === undefined) throw new Error("Missing Harness PID");
    const stoppedPid = childPid;
    expect(() => process.kill(stoppedPid, 0)).toThrow();
    passed = true;
  } finally {
    await components?.dispose();
    await helper.stop(500);
    await diagnostics;
    vi.unstubAllEnvs();
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);
