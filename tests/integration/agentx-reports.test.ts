import { fixtureFailure } from "../fixtures/results/store-fixture.js";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";
import { AgentXPerformanceMetrics } from "../../src/plugins/metrics/agentx-performance.js";
import { DurationMetrics } from "../../src/plugins/metrics/duration.js";
import { UsageMetrics } from "../../src/plugins/metrics/usage.js";
import { normalizeAgentXExport } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { normalizeTelemetry } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { saveReport, rebuildReport } from "../../src/application/report/index.js";
import { taskReportSnapshot } from "../../src/application/report/snapshot.js";
import { storeRun, storeRecord } from "../fixtures/results/store-fixture.js";
import { workload, lexicon, profileExport } from "../fixtures/agentx/export.js";
import { serverMetricsEvidence, telemetryConfig } from "../fixtures/agentx/server-metrics.js";

const roots: string[] = [], stores: LocalRunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const plugins = () => [new AgentXPerformanceMetrics(), new DurationMetrics(), new UsageMetrics()];
async function setup(concurrencies = [1, 4, 8], failed?: number, pending?: number) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-reports-")); roots.push(root);
  const store = new LocalRunStore(); stores.push(store);
  const ids = concurrencies.map(n => `agentx-256k-standard-c${n}`);
  await store.create(root, { ...storeRun, taskIds: ids, evaluationKind: "performance",
    source: { source: "fixture", revision: workload.revision, metadata: {},
      files: [{ path: "traces.jsonl", origin: "https://fixture.invalid/traces", sha256: workload.sha256 }] } },
  { metrics: plugins().map(metric => ({ name: metric.name, config: {} })), reporter: { name: "markdown", config: {} } });
  for (const n of concurrencies) {
    if (n === pending) continue;
    const key = { runId: storeRun.runId, taskId: `agentx-256k-standard-c${n}`, attemptId: "attempt-1" };
    await store.allocate(key);
    const record = storeRecord(key);
    record.evaluationKind = "performance";
    record.scoreStatus = "not-applicable";
    record.executionStatus = "completed";
    record.cleanupStatus = "cleaned";
    record.verdict = { passed: null, details: {} };
    record.durationMs = n * 1000;
    const summary = normalizeAgentXExport(profileExport(), { ...workload, concurrency: n }, lexicon);
    const evidence = serverMetricsEvidence();
    summary.telemetry = normalizeTelemetry(telemetryConfig, "fixture-model", evidence);
    if (record.solve) {
      record.solve.observations = summary;
      record.solve.usage = { inputTokens: n * 100, outputTokens: n * 10, totalTokens: n * 110 };
    }
    if (failed === n) {
      record.executionStatus = "failed"; record.scoreStatus = record.evaluationKind === "performance" ? "not-applicable" : "invalid";
      record.executionStatus = "failed";
      record.errors = [fixtureFailure("solve", "INTERNAL_ERROR", `failed-c${n}`)];
      record.solve = null; record.verdict = null;
    }
    await store.commit(record, { files: [], missing: [] });
  }
  await store.updateRun({ status: failed || pending ? "error" : "completed", durationMs: 999999,
    finishedAt: "2026-09-18T01:00:00.000Z",
    ...(failed ? { failure: fixtureFailure("solve", "INTERNAL_ERROR", `failed-c${failed}`) } : {}) });
  return { store, directory: join(root, storeRun.runId) };
}

test("three concurrency points publish independent reports, metrics and working evidence links", async () => {
  const { store, directory } = await setup();
  await saveReport(store, plugins(), new MarkdownReporter());
  const index = await readFile(join(directory, "report.md"), "utf8");
  expect(index).toContain("# AgentX 评测报告目录");
  expect(index).not.toContain("## Metrics");
  expect(index).not.toContain("TTFT");
  for (const n of [1, 4, 8]) {
    expect(index).toContain(`points/c${n}/report.md`);
    const location = join(directory, "points", `c${n}`);
    const report = await readFile(join(location, "report.md"), "utf8");
    const saved = JSON.parse(await readFile(join(location, "metrics.json"), "utf8"));
    expect(saved.metrics["agentx-performance"].points).toHaveLength(1);
    expect(saved.metrics["agentx-performance"].points[0].measurement.workload.concurrency).toBe(n);
    expect(saved.metrics.usage).toMatchObject({ selected: 1, recorded: 1, totalTokens: { total: n * 110 } });
    expect(saved.metrics.duration).toMatchObject({ runWallTimeMs: n * 1000, tasks: { count: 1 } });
    expect(saved.metrics["attempt-accounting"]).toMatchObject({ attempts: 1, durationMs: n * 1000 });
    expect(report).toContain("#### NPU 4 / chip 0");
    expect(report).toContain(`snapshotDigest: ${saved.snapshotDigest}`);
    expect(report).toContain("有效测量覆盖率：1/1");
    for (const other of [1, 4, 8].filter(other => other !== n)) expect(report).not.toContain(`agentx-256k-standard-c${other}`);
    const link = /\[result\]\(([^)]+)\)/u.exec(report)?.[1];
    if (!link) throw new Error("Missing result link");
    const result = JSON.parse(await readFile(resolve(location, link), "utf8"));
    expect(result.key.taskId).toBe(`agentx-256k-standard-c${n}`);

  }
});

test("failed sibling does not change a completed point's status or include its diagnostics", async () => {
  const { store, directory } = await setup([1, 4, 8], 8);
  await saveReport(store, plugins(), new MarkdownReporter());
  const c1 = await readFile(join(directory, "points/c1/report.md"), "utf8");
  const c8 = await readFile(join(directory, "points/c8/report.md"), "utf8");
  expect(c1).toContain("Status: completed");
  expect(c1).not.toContain("failed-c8");
  expect(c1).not.toContain("INTERNAL_ERROR");
  expect(c8).toContain("Status: error");
  expect(c8).toContain("INTERNAL_ERROR");
  expect(c8).not.toContain("failed-c8");
  expect((await store.snapshot()).records.find(record => record.key.taskId === "agentx-256k-standard-c8")?.errors[0]?.message).toBe("failed-c8");
  expect(c8).not.toContain("agentx-256k-standard-c1");
});

test("offline rebuild is identical and repairs a missing or modified point report", async () => {
  const { store, directory } = await setup();
  await saveReport(store, plugins(), new MarkdownReporter());
  const original = await readFile(join(directory, "points/c4/report.md"), "utf8");
  await store.close();
  await rebuildReport(directory);
  expect(await readFile(join(directory, "points/c4/report.md"), "utf8")).toBe(original);
  expect(await readdir(directory)).not.toContain("reports");
  await rm(join(directory, "points/c4/report.md"));
  await writeFile(join(directory, "points/c8/metrics.json"), "damaged");
  await rebuildReport(directory);
  const repaired = await readFile(join(directory, "points/c4/report.md"), "utf8");
  expect(repaired).toBe(original);
  expect(JSON.parse(await readFile(join(directory, "points/c8/metrics.json"), "utf8")).revision).toBe(1);
  expect(await readdir(directory)).not.toContain("reports");
});

test("single point retains the root detailed report", async () => {
  const { store, directory } = await setup([4]);
  await saveReport(store, plugins(), new MarkdownReporter());
  const report = await readFile(join(directory, "report.md"), "utf8");
  expect(report).toContain("### 测量点 agentx-256k-standard-c4");
  expect(report).not.toContain("评测报告目录");
});

test("a pending point gets its own incomplete report with unknown usage", async () => {
  const { store, directory } = await setup([1, 4, 8], undefined, 8);
  await saveReport(store, plugins(), new MarkdownReporter());
  const report = await readFile(join(directory, "points/c8/report.md"), "utf8");
  expect(report).toContain("未完成");
  expect(report).toContain("agentx-256k-standard-c8 | pending");
  expect(report).not.toContain("agentx-256k-standard-c1");
  const saved = JSON.parse(await readFile(join(directory, "points/c8/metrics.json"), "utf8"));
  expect(saved.metrics.usage).toMatchObject({ selected: 1, recorded: 0, totalTokens: { total: null } });
  expect(saved.metrics.duration.runWallTimeMs).toBeNull();
});

test("report snapshot filters preparation, remote attempts and past attempts to its task", async () => {
  const { store } = await setup();
  const snapshot = await store.snapshot();
  const taskId = "agentx-256k-standard-c4";
  snapshot.run.preparationRounds = [{ id: "shared", taskIds: snapshot.run.taskIds,
    policy: { version: "fixture", source: "fixture" }, budgetSeconds: 3600,
    startedAt: snapshot.run.startedAt, deadlineAt: "2026-09-18T01:00:00.000Z",
    finishedAt: "2026-09-18T00:00:09.000Z", status: "error", error: "sibling preparation failed",
    tasks: snapshot.run.taskIds.map(id => ({ taskId: id, status: "ready", queuedAt: snapshot.run.startedAt,
      startedAt: snapshot.run.startedAt, finishedAt: "2026-09-18T00:00:02.000Z",
      queueDurationMs: 0, durationMs: 2000, phaseDurationMs: {} })) }];
  snapshot.run.remoteAttempts = snapshot.records.map(record => ({ key: record.key,
    nodeId: null, hostname: null, state: "collected", transferId: null, receipt: null, message: null }));
  const selected = taskReportSnapshot(snapshot, taskId);
  expect(selected.attemptHistory).toHaveLength(1);
  expect(selected.run.remoteAttempts).toHaveLength(1);
  expect(selected.run.preparationRounds?.[0]).toMatchObject({ taskIds: [taskId], status: "ready",
    finishedAt: "2026-09-18T00:00:02.000Z" });
  expect(selected.run.preparationRounds?.[0]?.error).toBeUndefined();
  expect(selected.run.preparationRounds?.[0]?.tasks).toHaveLength(1);
  expect(snapshot.run.taskIds).toHaveLength(3);
  expect(snapshot.run.preparationRounds[0]?.tasks).toHaveLength(3);
});

test("point report publication rejects directory junctions and unsafe target IDs", async () => {
  const { store, directory } = await setup();
  const snapshot = await store.snapshot();
  const base = { id: "../escape", taskId: snapshot.run.taskIds[0] ?? "", title: "test",
    snapshotDigest: snapshot.digest, metrics: {}, markdown: "test" };
  await expect(store.saveReportBundle(snapshot.digest, {}, "index", [base])).rejects.toMatchObject({ code: "REPORT_FAILED" });
  const outside = join(dirname(directory), "outside"); await mkdir(outside);
  await symlink(outside, join(directory, "points"), process.platform === "win32" ? "junction" : "dir");
  await expect(saveReport(store, plugins(), new MarkdownReporter())).rejects.toThrow("Symlink evidence rejected");
  expect(await readdir(outside)).toEqual([]);
});

test("resume preserves independent point reports and retry updates only the current directory", async () => {
  const { store, directory } = await setup();
  await saveReport(store, plugins(), new MarkdownReporter());
  await saveReport(store, plugins(), new MarkdownReporter(), "resume");
  const old = await readFile(join(directory, "reports/initial/points/c4/report.md"), "utf8");
  await store.updateRun({ durationMs: 12345 });
  await saveReport(store, plugins(), new MarkdownReporter());
  expect(await readFile(join(directory, "reports/initial/points/c4/report.md"), "utf8")).toBe(old);
  for (const name of ["initial", "resume-1"]) {
    const folder = join(directory, "reports", name, "points/c4");
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    const link = /\[result\]\(([^)]+)\)/u.exec(markdown)?.[1];
    if (!link) throw new Error("Missing archived evidence link");
    expect(JSON.parse(await readFile(resolve(folder, link), "utf8")).key.taskId).toBe("agentx-256k-standard-c4");
    expect(JSON.parse(await readFile(join(folder, "metrics.json"), "utf8")).metrics.usage.selected).toBe(1);
  }
  await saveReport(store, plugins(), new MarkdownReporter(), "resume");
  expect((await readdir(join(directory, "reports"))).sort()).toEqual(["current.json", "initial", "resume-1", "resume-2"]);
});
