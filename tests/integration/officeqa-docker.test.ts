import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/index.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { officeQAFiles, fixtureCSV } from "../fixtures/officeqa.js";
import { harness } from "../fixtures/engine/fakes.js";
import { runEngine } from "../../src/application/run-engine.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { trajectoryLines } from "../fixtures/results/store-fixture.js";
import { saveReport, rebuildReport } from "../../src/application/report/index.js";
import { SuccessRateMetrics } from "../../src/plugins/metrics/success-rate.js";
import { MarkdownReporter } from "../../src/plugins/reporters/markdown.js";

const enabled = process.env.EVALUATOR_OFFICEQA_DOCKER_TESTS === "1";
test.skipIf(!enabled).each(["parsed-json", "pdf"] as const)("OfficeQA %s Docker corpus, tools, private official grading and image reuse", async corpusFormat => {
  const root = await mkdtemp(join(tmpdir(), "officeqa-docker-")); const { components, config, dispose } = harness(root);
  try {
    const fixture = await officeQAFiles(join(root, "source"), corpusFormat, fixtureCSV.replace('"$7,046,001.98"', "21.58"));
    components.benchmark = new OfficeQAProV2Benchmark(parseOfficeQAProV2Config({ cacheDir: join(root, "cache"), corpusFormat }), fixture.source, { questions: 2, documents: 2 });
    const environment = new DockerEnvironment(); components.environment = environment;
    const images: unknown[] = [];
    const corpusImages: unknown[] = [];
    const materialize = environment.materialize.bind(environment);
    vi.spyOn(environment, "materialize").mockImplementation(async (...args) => {
      const ready = await materialize(...args);
      const receipt = ready.prepared;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Missing Docker receipt");
      const base = receipt.baseImage;
      if (!base || typeof base !== "object" || Array.isArray(base)) throw new Error("Missing corpus image receipt");
      corpusImages.push(base.id);
      images.push(receipt.launchImage); return ready;
    });
    components.solver.requirements = () => [];
    components.solver.solve = async (input, session, context) => {
      expect(JSON.stringify(input)).not.toMatch(/private-page|private-reference|answer":/);
      const command = corpusFormat === "pdf"
        ? "pdftotext /corpus/public-a.pdf -; pdftoppm -f 1 -singlefile -scale-to 100 -png /corpus/public-a.pdf /workspace/page >/dev/null 2>&1"
        : "python3 -c 'import json; print(json.load(open(\"/corpus/public-a.json\"))[\"document\"][\"elements\"][0][\"content\"])'";
      const output = await readProcess(await session.start({ executable: "sh", args: ["-ec", `test $(find /corpus -type f | wc -l) -eq 2; test ! -f /corpus/officeqa_pro_v2.csv; test ! -f /reward.py; rg --version >/dev/null; ${command}`],
        cwd: "/workspace", env: {}, input: null }, context.signal), context.signal);
      expect(output.code, output.stderr).toBe(0); expect(output.stdout).toContain("21.58");
      const answer = output.stdout.match(/\d+\.\d+/)?.[0]; if (!answer) throw new Error("No extracted answer");
      await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1, 2], context.key));
      await writeFile(join(context.paths.agent, "session.jsonl"), "{}\n");
      return { finalText: `<FINAL_ANSWER>${answer}</FINAL_ANSWER>`, usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
    };
    config.experiment.environment = { name: "docker", config: {} };
    config.experiment.run = { ...config.experiment.run, maxTasks: 2, timeoutSeconds: 300 };
    config.persisted = { fixture: true, metrics: [{ name: "success-rate", config: {} }], reporter: { name: "markdown", config: {} } };
    components.metrics = [new SuccessRateMetrics()]; components.reporter = new MarkdownReporter();
    for (let repeat = 0; repeat < 2; repeat++) {
      const snapshot = await runEngine({ components, config, signal: AbortSignal.timeout(600_000) });
      expect(snapshot.records[0]?.errors).toEqual([]);
      expect(snapshot.records[0]).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1, passed: true, details: { corpusFormat } } });
      expect(snapshot.records).toHaveLength(2);
      expect(snapshot.records.every(record => record.verdict?.passed === true)).toBe(true);
      expect(snapshot.records[0]?.task).toBeUndefined();
      await saveReport(components.store, components.metrics, components.reporter);
      const runDir = join(config.experiment.output.directory, snapshot.run.runId);
      expect(await readFile(join(runDir, "report.md"), "utf8")).toContain('| 正确率 | 100.00% |');
      await components.store.close();
      await rebuildReport(runDir);
    }
    expect(images).toHaveLength(4);
    expect(images.every(image => typeof image === "string" && image.startsWith("sha256:"))).toBe(true);
    expect(new Set(images.slice(0, 2))).toEqual(new Set(images.slice(2)));
    expect(new Set(corpusImages).size).toBe(1);
  } finally { vi.restoreAllMocks(); await dispose(); await rm(root, { recursive: true, force: true }); }
}, 900_000);
