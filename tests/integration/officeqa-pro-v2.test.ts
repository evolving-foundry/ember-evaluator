import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/index.js";
import { officeQAFiles } from "../fixtures/officeqa.js";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { saveReport, rebuildReport } from "../../src/application/report/index.js";
import { SuccessRateMetrics } from "../../src/plugins/metrics/success-rate.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";
import { trajectoryLines } from "../fixtures/results/store-fixture.js";
import { writeFile } from "node:fs/promises";

test("OfficeQA controlled solver completes, persists answers only on request, reports offline and resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "officeqa-engine-")); const { components, config } = harness(root);
  try {
    const fixture = await officeQAFiles(join(root, "data"), "parsed-json");
    const benchmark = new OfficeQAProV2Benchmark(parseOfficeQAProV2Config({ cacheDir: join(root, "cache") }), fixture.source, { questions: 2, documents: 2 });
    components.benchmark = benchmark;
    // Default suite exercises orchestration without Docker; the separate Docker test uses the real runtime.
    const disposed = vi.fn(async () => {});
    vi.spyOn(benchmark.verificationRuntime, "materialize").mockResolvedValue({ fixture: true });
    vi.spyOn(benchmark.verificationRuntime, "prepare").mockImplementation(async task => ({ metadata: { fixture: true }, dispose: disposed,
      async verify(result) { const expected = task.input.id === "qid_7" ? "21.58" : "$7,046,001.98"; const passed = result.finalText === expected; return { score: Number(passed), passed, details: { controlled: true } }; } }));
    components.environment.materialize = async spec => spec;
    const prepare = components.environment.prepare.bind(components.environment);
    components.environment.prepare = async (...args) => ({ ...await prepare(...args), async quiesce() {} });
    const solves = vi.fn(async (input, _session, context) => {
      expect(input).not.toHaveProperty("verification"); expect(JSON.stringify(input)).not.toContain("private-");
      await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1, 2], context.key));
      await writeFile(join(context.paths.agent, "session.jsonl"), "{}\n");
      return { finalText: input.id === "qid_7" ? "21.58" : "$7,046,001.98", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    });
    components.solver.solve = solves;
    components.metrics = [new SuccessRateMetrics()]; components.reporter = new MarkdownReporter();
    config.experiment.environment = { name: "docker", config: {} };
    config.experiment.run = { ...config.experiment.run, maxTasks: 1, includeTaskAnswer: true };
    config.persisted = { fixture: true, metrics: [{ name: "success-rate", config: {} }], reporter: { name: "markdown", config: {} } };
    const snapshot = await runEngine({ components, config, signal: AbortSignal.timeout(10_000) });
    expect(snapshot.run.status, JSON.stringify(snapshot.records.map(record => record.errors))).toBe("completed"); expect(snapshot.run.taskIds).toEqual(["qid_7"]);
    expect(snapshot.records[0]).toMatchObject({ scoreStatus: "valid", verdict: { score: 1 }, task: { answer: "21.58" } });
    expect(disposed).toHaveBeenCalledOnce();
    const runDir = join(config.experiment.output.directory, snapshot.run.runId);
    await saveReport(components.store, components.metrics, components.reporter);
    expect(await readFile(join(runDir, "report.md"), "utf8")).toContain('| 正确率 | 100.00% |');
    await components.store.close();
    await rebuildReport(runDir);
    const resumed = await runEngine({ components, config, signal: AbortSignal.timeout(10_000), resumeDirectory: runDir });
    expect(resumed.run.status).toBe("completed"); expect(solves).toHaveBeenCalledOnce();
    expect(resumed.run.source?.files).toHaveLength(3);
  } finally { vi.restoreAllMocks(); await components.dispose(); await rm(root, { recursive: true, force: true }); }
});
