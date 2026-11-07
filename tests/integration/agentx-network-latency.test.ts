import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../../src/application/config.js";
import { expectRecord } from "../../src/core/validation/input.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { normalizeAgentXExport } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { parseNetworkLatencyConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/network-latency.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { AgentXPerformanceMetrics } from "../../src/plugins/metrics/agentx-performance.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";
import { rebuildReport, saveReport } from "../../src/application/report/index.js";
import { workload, lexicon, profileExport, networkProfileExport } from "../fixtures/agentx/export.js";
import { storeRecord, storeRun } from "../fixtures/results/store-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function root() {
  await mkdir(".scratch", { recursive: true });
  const directory = await mkdtemp(resolve(".scratch/agentx-network-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const signal = () => new AbortController().signal;

test.each(["automatic", "manual"])("YAML %s calibration reaches saved local and Docker Solver observations", async mode => {
  const directory = await root();
  const tokenizer = join(directory, "tokenizer"); await mkdir(tokenizer);
  await writeFile(join(tokenizer, "tokenizer.json"), "controlled-tokenizer");
  const networkLatency = parseNetworkLatencyConfig(mode === "automatic" ? { mode, pingIntervalSeconds: 0.5 } : { mode, meanMs: 4 });
  const file = join(directory, "experiment.yaml");
  await writeFile(file, stringify({
    services: { default: { model: "fixture-model", base_url: "http://localhost:8000/v1", api_key: "${AGENTX_NETWORK_KEY}" } },
    benchmark: { name: "agentx", solver: { config: { tokenizer, networkLatency, cacheDir: join(directory, "cache") } } },
  }));
  const loaded = await loadConfig(file, {}, { ...process.env, AGENTX_NETWORK_KEY: "controlled-secret" });
  for (const environmentName of ["local", "docker"]) {
    const paths = { root: join(directory, environmentName), agent: join(directory, environmentName, "agent"),
      verifier: join(directory, environmentName, "verifier"), artifacts: join(directory, environmentName, "artifacts") };
    const session = await new LocalEnvironment(directory).prepare({ workdir: ".", image: null, initialFiles: [], runtime: [] }, paths, "solve", signal());
    cleanup.push(() => session.dispose(signal()));
    session.runtime = { root: directory, identity: "controlled-runtime", persistent: false };
    async function* stream(text: string) { yield Buffer.from(text); }
    session.start = async command => {
      const request = expectRecord(JSON.parse(Buffer.from(command.input ?? "").toString("utf8")), "bridge request");
      expect(request.networkLatency).toEqual(networkLatency);
      return { stdout: stream(JSON.stringify({ schemaVersion: 1, type: "result", export: networkProfileExport(),
        ...(mode === "automatic" ? { networkLatencyProbes: { total: 4, successful: 3, failed: 1 } } : {}) })),
      stderr: stream(""), done: Promise.resolve({ code: 0, signal: null }), stop: async () => {} };
    };
    const model = { name: "fixture-model", endpoint: "http://localhost:8000/v1", api: "openai-completions", provider: null };
    const solver = new AgentXReplaySolver(parseAgentXReplayConfig(loaded.experiment.solver.config),
      { services: { default: { model, auth: { value: "controlled-secret", reference: null } } }, solverService: "default", environmentName,
        configDirectory: directory, resolvePath: name => resolve(directory, name) });
    const result = await solver.solve({ id: "point", prompt: "", payload: workload }, session,
      { key: { runId: "run", taskId: "point", attemptId: "attempt" }, paths, signal: signal() });
    const observations = expectRecord(result.observations, "observations");
    expect(observations.networkLatency).toMatchObject({ config: networkLatency, status: mode === "automatic" ? "partial" : "complete", rttMs: 4 });
    expect(JSON.parse(await readFile(join(paths.agent, "agentx-summary.json"), "utf8"))).toEqual(observations);
    expect(JSON.stringify(observations)).not.toContain("controlled-secret");
  }
});

test("per-point reports preserve raw and adjusted metrics, failed probes and offline reproducibility", async () => {
  const directory = await root();
  const store = new LocalRunStore(); cleanup.push(() => store.close());
  const ids = ["point-1", "point-4", "point-8"];
  await store.create(directory, { ...storeRun, taskIds: ids, evaluationKind: "performance", source: {
    source: "fixture", revision: workload.revision, metadata: {},
    files: [{ path: "traces.jsonl", origin: "https://fixture.invalid/traces", sha256: workload.sha256 }] } },
  { metrics: [{ name: "agentx-performance", config: {} }], reporter: { name: "markdown", config: {} } });
  for (const [index, taskId] of ids.entries()) {
    const key = { runId: storeRun.runId, taskId, attemptId: "attempt-1" };
    await store.allocate(key);
    const record = storeRecord(key);
    record.evaluationKind = "performance"; record.scoreStatus = "not-applicable";
    record.executionStatus = "completed"; record.cleanupStatus = "cleaned";
    record.verdict = { passed: null, details: {} };
    if (!record.solve) throw new Error("Missing fixture solve");
    record.solve.observations = normalizeAgentXExport(index === 2 ? profileExport() : networkProfileExport(), { ...workload, concurrency: [1, 4, 8][index] ?? 1 }, lexicon, undefined,
      index === 0 ? { config: { mode: "automatic", pingIntervalSeconds: 1 }, probes: { total: 3, successful: 2, failed: 1 } }
        : index === 1 ? { config: { mode: "manual", meanMs: 4 } }
          : { config: { mode: "automatic", pingIntervalSeconds: 1 }, probes: { total: 3, successful: 0, failed: 3 } });
    await store.commit(record, { files: [], missing: [] });
  }
  await store.updateRun({ status: "completed", finishedAt: "2026-10-29T00:00:00.000Z", durationMs: 1000 });
  await saveReport(store, [new AgentXPerformanceMetrics()], new MarkdownReporter());
  const runDirectory = join(directory, storeRun.runId);
  const automaticReport = await readFile(join(runDirectory, "points/c1/report.md"), "utf8");
  const manualReport = await readFile(join(runDirectory, "points/c4/report.md"), "utf8");
  const unavailableReport = await readFile(join(runDirectory, "points/c8/report.md"), "utf8");
  expect(automaticReport).toContain("校准数据状态：partial");
  expect(automaticReport).toContain("总计 3；成功 2；失败 1");
  expect(automaticReport).toContain("RTT 探测失败 1 次");
  expect(automaticReport).toContain("| point-1 | TTFT 原始 | ms | 12 | 10 | 25 | 31 | 120 |");
  expect(automaticReport).toContain("| point-1 | TTFT 扣除 RTT 后 | ms | 8.125 | 6 | 21 | 27 | 120 |");
  expect(manualReport).toContain("手动 RTT，配置值 4 ms");
  expect(manualReport).toContain("不适用（手动指定 RTT）");
  expect(unavailableReport).toContain("校准数据状态：unavailable");
  expect(unavailableReport).toContain("平均 RTT：— ms");
  expect(unavailableReport).toContain("| point-8 | TTFT 原始 | ms | 12 | 10 | 25 | 31 | 120 |");
  expect(unavailableReport).toContain("| point-8 | TTFT 扣除 RTT 后 | — | — | — | — | — | — |");
  const metricsFile = join(runDirectory, "points/c1/metrics.json");
  const metrics = await readFile(metricsFile, "utf8");
  expect(JSON.parse(metrics).metrics["agentx-performance"].points[0].measurement.networkLatency.rttMs).toBe(4);
  await store.close();
  await rebuildReport(runDirectory);
  expect(await readFile(join(runDirectory, "points/c1/report.md"), "utf8")).toBe(automaticReport);
  expect(await readFile(join(runDirectory, "points/c4/report.md"), "utf8")).toBe(manualReport);
  expect(await readFile(join(runDirectory, "points/c8/report.md"), "utf8")).toBe(unavailableReport);
  expect(await readFile(metricsFile, "utf8")).toBe(metrics);
});
