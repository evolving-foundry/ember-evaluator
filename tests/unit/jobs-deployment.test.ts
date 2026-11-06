import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RayJobsDeployment } from "../../src/application/ray/deployment.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { parseJobsConfig } from "../../src/config/jobs.js";
import { downloadRunResults, localizeRunPluginRuntime } from "../../src/application/ray/jobs-results.js";
import { rebuildReport } from "../../src/application/report/index.js";
import type { PluginFactoryContext } from "../../src/core/contracts/plugin.js";
import type { PluginConfigTransport } from "../../src/core/contracts/config-transport.js";
import { localizePortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { classifyError } from "../../src/core/errors/classify.js";

vi.mock("../../src/application/ray/jobs-results.js", () => ({ downloadRunResults: vi.fn(), localizeRunPluginRuntime: vi.fn(), buildResumeSeed: vi.fn() }));
vi.mock("../../src/application/report/index.js", () => ({ rebuildReport: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

test.each([false, true])("Jobs image cleanup returns maintenance results without model auth: execute=%s", async execute => {
  const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
  vi.spyOn(JobsClient, "create").mockResolvedValue(client);
  const summary = { preview: !execute, nodes: [{ nodeId: "node-a", daemonId: "daemon-a", items: [] }] };
  const call = vi.spyOn(client, "call").mockImplementation(async path => path.endsWith("/image-cleanup") ? summary : {});
  vi.spyOn(client, "attach").mockResolvedValue(0);
  const selected = { name: "fixture", config: {} };
  const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem" }),
    { services: {}, solverService: "", configDirectory: ".", resolvePath: path => path });
  expect(await deployment.cleanupImages({ services: { default: { apiKey: "must-not-send" } }, benchmark: selected, environment: selected,
    solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [], run: {}, output: {} }, {}, { all: false, execute },
  { signal: AbortSignal.timeout(1000), log() {} })).toEqual(summary);
  expect(call.mock.calls[0]?.[1]).toMatchObject({ operation: "cleanup-images", serviceAuth: {}, cleanup: { all: false, execute } });
  expect(JSON.stringify(call.mock.calls)).not.toContain("must-not-send");
  expect(vi.mocked(downloadRunResults)).not.toHaveBeenCalled();
});

test.each([false, true])("Jobs warmup submits no model credentials and retrieves only preparation results: failure=%s", async fails => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-warmup-"));
  try {
    const summary = { status: fails ? "error" : "ready", taskIds: ["a"], readyTaskIds: fails ? [] : ["a"],
      failures: fails ? [{ taskId: "a", failure: classifyError(new Error("failed"), { phase: "prepare", component: "environment" }) }] : [],
      placements: [{ taskId: "a", nodeId: "node-a" }], preparationRounds: [], durationMs: 100 };
    const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
    vi.spyOn(JobsClient, "create").mockResolvedValue(client);
    const call = vi.spyOn(client, "call").mockImplementation(async path => path.endsWith("/warmup") ? summary : {});
    vi.spyOn(client, "attach").mockResolvedValue(fails ? 1 : 0);
    const model = { name: "fixture", endpoint: "https://model.invalid", provider: null, api: "openai-completions" };
    const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem", nodes: 2 }),
      { services: { default: { model, auth: { value: "", reference: null } } }, solverService: "default", configDirectory: root, resolvePath: path => path });
    const selected = { name: "fixture", config: {} };
    const config = { services: { default: { ...model, apiKey: "must-not-transfer" } }, benchmark: selected, environment: selected,
      solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [], output: { directory: root } };
    const result = await deployment.warmupExperiment(config, {}, { signal: AbortSignal.timeout(10_000), log() {} });
    expect(result).toEqual(summary);
    const submission = call.mock.calls.find(([path]) => path.endsWith("/submit"))?.[1];
    expect(submission).toMatchObject({ operation: "warmup", serviceAuth: {}, config: { scheduler: { config: { nodes: 2 } } } });
    expect(JSON.stringify(submission)).not.toContain("must-not-transfer");
    expect(call.mock.calls.map(([path]) => path).some(path => /manifest|\/file|\/retry/u.test(path))).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Jobs warmup cancellation requests stop and waits with an independent signal", async () => {
  const controller = new AbortController();
  const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
  vi.spyOn(JobsClient, "create").mockResolvedValue(client);
  const call = vi.spyOn(client, "call").mockResolvedValue({});
  const signals: AbortSignal[] = [];
  vi.spyOn(client, "attach").mockImplementation(async (_id, _log, signal) => {
    signals.push(signal);
    if (signals.length === 1) { controller.abort(new Error("cancelled")); throw controller.signal.reason; }
    return 1;
  });
  const model = { name: "fixture", endpoint: null, provider: null, api: "openai-completions" };
  const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem" }),
    { services: { default: { model, auth: { value: "", reference: null } } }, solverService: "default", configDirectory: ".", resolvePath: path => path });
  const selected = { name: "fixture", config: {} };
  await expect(deployment.warmupExperiment({ services: { default: model }, benchmark: selected, environment: selected,
    solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [] }, {},
  { signal: controller.signal, log() {} })).rejects.toThrow("cancelled");
  expect(signals).toHaveLength(2); expect(signals[1]).not.toBe(controller.signal);
  expect(call.mock.calls.some(([path]) => path.endsWith("/cancel"))).toBe(true);
});

test("Jobs submission uses external component declarations and restores host fields on the coordinator", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-transport-"));
  try {
    const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
    vi.spyOn(JobsClient, "create").mockResolvedValue(client);
    const calls = vi.spyOn(client, "call").mockResolvedValue({});
    vi.spyOn(client, "attach").mockResolvedValue(0);
    vi.mocked(downloadRunResults).mockResolvedValue(join(root, "saved-run"));
    vi.mocked(localizeRunPluginRuntime).mockResolvedValue(undefined);
    vi.mocked(rebuildReport).mockResolvedValue(undefined);
    const model = { name: "fixture", endpoint: "https://model.invalid", provider: null, api: "openai-completions" };
    const auth = { value: "model-key", reference: null };
    const policies: Record<string, PluginConfigTransport> = {
      "benchmark:external": { nodeLocal: { dataCache: "cache" }, containerPaths: [["workdir"]], secretFields: ["datasetToken"] },
      "environment:external": { nodeLocal: { engine: "docker" } },
    };
    const lookup = (role: string, name: string) => policies[`${role}:${name}`];
    const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem" }),
      { services: { default: { model, auth } }, solverService: "default", configDirectory: root, resolvePath: path => join(root, path) }, lookup);
    const selected = { name: "fixture", config: {} };
    const config = { services: { default: model },
      benchmark: { name: "external", config: { dataCache: "C:\\client-cache", workdir: "/workspace", datasetToken: "private-dataset-credential" } },
      environment: { name: "external", config: { engine: "/client/docker" } },
      solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [], output: { directory: root } };
    await deployment.runExperiment(config, {}, { signal: AbortSignal.timeout(10000), log() {} });
    const submission = calls.mock.calls.find(([route]) => route.endsWith("/submit"));
    expect(submission).toBeDefined();
    const body = submission?.[1] as { config: typeof config };
    expect(submission?.[1]).toMatchObject({ serviceAuth: { default: "model-key" } });
    expect(submission?.[1]).not.toHaveProperty("auth");
    expect(body.config.benchmark.config).toEqual({ workdir: "/workspace" });
    expect(body.config.environment.config).toEqual({});
    expect(localizePortableSelection(body.config.benchmark, "benchmark", { outputRoot: "/jobs" }, lookup).config.dataCache)
      .toBe(join("/jobs", "cache", "benchmark", "external"));
    expect(config.benchmark.config.dataCache).toBe("C:\\client-cache");
    expect(config.benchmark.config.datasetToken).toBe("private-dataset-credential");
    expect(JSON.stringify(submission?.[1])).not.toContain("private-dataset-credential");
    const retry = (await readdir(join(root, ".jobs"))).find(name => name.endsWith("-retry.yaml"));
    expect(retry).toBeDefined();
    const retryConfig = await readFile(join(root, ".jobs", retry!), "utf8");
    expect(retryConfig).not.toContain("private-dataset-credential");
    expect(retryConfig).not.toContain("datasetToken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["success", "download-error", "report-error"])("Jobs structured result includes collection and report state: %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-sdk-"));
  try {
    const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
    vi.spyOn(JobsClient, "create").mockResolvedValue(client);
    vi.spyOn(client, "call").mockResolvedValue({});
    vi.spyOn(client, "attach").mockResolvedValue(0);
    vi.mocked(downloadRunResults).mockReset();
    vi.mocked(rebuildReport).mockReset();
    vi.mocked(localizeRunPluginRuntime).mockResolvedValue(undefined);
    const destination = join(root, "downloaded-run");
    if (mode === "download-error") vi.mocked(downloadRunResults).mockRejectedValue(new Error("download failed"));
    else vi.mocked(downloadRunResults).mockResolvedValue(destination);
    if (mode === "report-error") vi.mocked(rebuildReport).mockRejectedValue(new Error("report failed"));
    else vi.mocked(rebuildReport).mockResolvedValue(undefined);
    const model = { name: "fixture", endpoint: "https://model.invalid", provider: null, api: "openai-completions" };
    const auth = { value: "model-key", reference: null };
    const runtime: PluginFactoryContext = { services: { default: { model, auth } }, solverService: "default", configDirectory: root, resolvePath: path => join(root, path) };
    const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem" }), runtime);
    const selected = { name: "fixture", config: {} };
    const config = { services: { default: model }, benchmark: selected, environment: selected,
      solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [], output: { directory: root } };
    const result = await deployment.runExperiment(config, {}, { signal: AbortSignal.timeout(10000), log() {} });
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.runId).toBeTruthy();
    expect(result.collectionError).toBe(mode === "download-error" ? "download failed" : null);
    expect(result.reportError).toBe(mode === "report-error" ? "report failed" : null);
    expect(result.runDirectory).toBe(mode === "download-error" ? null : destination);
    expect(result.reportPath).toBe(mode === "success" ? join(destination, "report.md") : null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([false, true])("Jobs cancellation collects partial evidence with an independent bounded signal: download fails=%s", async fails => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-cancel-"));
  try {
    const controller = new AbortController();
    const client = new JobsClient("https://jobs.invalid", Buffer.from("fixture"), "j".repeat(32));
    const call = vi.spyOn(client, "call").mockResolvedValue({});
    const signals: AbortSignal[] = [];
    vi.spyOn(client, "attach").mockImplementation(async (_id, _log, signal) => {
      signals.push(signal);
      if (signals.length === 1) controller.abort();
      else expect(signal.aborted).toBe(false);
      return 130;
    });
    vi.spyOn(JobsClient, "create").mockResolvedValue(client);
    vi.mocked(downloadRunResults).mockReset();
    if (fails) vi.mocked(downloadRunResults).mockRejectedValue(new Error("gateway unavailable"));
    else vi.mocked(downloadRunResults).mockResolvedValue(join(root, "saved-run"));
    vi.mocked(localizeRunPluginRuntime).mockResolvedValue(undefined);
    const model = { name: "fixture", endpoint: "https://model.invalid", provider: null, api: "openai-completions" };
    const auth = { value: "model-key", reference: null };
    const runtime: PluginFactoryContext = { services: { default: { model, auth } }, solverService: "default", configDirectory: root, resolvePath: path => join(root, path) };
    const deployment = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://jobs.invalid", caFile: "cert.pem" }), runtime);
    const selected = { name: "fixture", config: {} };
    const config = { services: { default: model }, benchmark: selected, environment: selected, solver: { ...selected, service: "default" }, store: selected, reporter: selected, metrics: [], output: { directory: root } };
    const logs: string[] = [];
    expect(await deployment.submitExperiment(config, {}, { signal: controller.signal, log: text => logs.push(text) })).toBe(130);
    expect(signals).toHaveLength(2);
    expect(signals[1]).not.toBe(controller.signal);
    expect(call.mock.calls.some(([path]) => path.endsWith("/cancel"))).toBe(true);
    expect(vi.mocked(downloadRunResults).mock.calls[0]?.[4]).toBe(signals[1]);
    const receipts = (await readdir(join(root, ".jobs"))).filter(name => name.endsWith(".json"));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(root, ".jobs", receipts[0]!), "utf8"));
    if (fails) expect(logs.join("\n")).toContain("Result download failed");
    else { expect(receipt.runId).toBe("saved-run"); expect(rebuildReport).toHaveBeenCalled(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
