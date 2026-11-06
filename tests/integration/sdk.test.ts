import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Evaluator, EvaluatorRunError, type EvaluatorRunOptions, type ProgressEvent } from "ember-evaluator";
import { RayJobsDeployment } from "../../src/application/ray/deployment.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import * as assembly from "../../src/application/plugins/bootstrap.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  delete (globalThis as Record<string, unknown>).__cliResumeContinue;
  delete (globalThis as Record<string, unknown>).__cliReportCalls;
});

async function fixture(mode = "pass", extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-sdk-"));
  roots.push(root);
  await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "cli.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/sdk/plugin.mjs"), join(root, "plugin.mjs"));
  const patchPath = join(root, "patch.yaml"), configPath = join(root, "config.yaml");
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "sdk-fixture", name: "./plugin.mjs" }] }]));
  await writeFile(configPath, JSON.stringify({
    services: { default: { model: "sdk-fixture", base_url: "https://fixture.invalid", api_key: "${SDK_KEY}" } },
    benchmark: { name: "cli-fixture", config: { mode }, solver: { name: "cli-fixture", config: { mode } } },
    environment: "local", run: { },
    output: { directory: "./results" },
    ...(mode === "report-error" ? { reporter: "cli-error" } : {}), ...extra,
  }));
  const options: EvaluatorRunOptions = { configPath, patchPath, env: { SDK_KEY: "SDK_SENSITIVE_TEST_VALUE" } };
  return { root, options };
}

async function released(root: string) {
  expect(await readFile(join(root, "lifecycle.log"), "utf8")).toBe("registered\ndisposed\n");
}

test.each(["pass", "wrong", "error"])("public SDK runs %s with a persisted report and releases its writer lock", async mode => {
  const { root, options } = await fixture(mode);
  const events: ProgressEvent[] = [];
  const result = await new Evaluator().run({ ...options, onProgress: event => events.push(event) });
  expect(result.kind).toBe("local");
  expect(result.exitCode).toBe(mode === "error" ? 1 : 0);
  expect(result.runDirectory).toMatch(new RegExp("results"));
  if (result.kind !== "local") throw new Error("Expected a local result");
  expect(result.snapshot.run.status).toBe(mode === "error" ? "error" : "completed");
  expect(result.snapshot.records[0]?.verdict?.passed).toBe(mode === "pass" ? true : mode === "wrong" ? false : undefined);
  expect(await readFile(result.reportPath!, "utf8")).toContain("sdk-fixture");
  expect(JSON.stringify(events)).not.toContain("SDK_SENSITIVE_TEST_VALUE");
  expect(await readFile(join(result.runDirectory, "config.yaml"), "utf8")).not.toContain("SDK_SENSITIVE_TEST_VALUE");
  await released(root);
  const store = new LocalRunStore();
  try { await store.open(result.runDirectory); } finally { await store.close(); }
});

test("SDK applies YAML offset and maxTasks", async () => {
  const { root, options } = await fixture("pass", {
    benchmark: { name: "cli-fixture", config: { mode: "pass", tasks: ["a", "b", "c"] }, solver: { name: "cli-fixture", config: { mode: "pass" } } },
    run: { offset: 1, maxTasks: 1 },
  });
  const result = await new Evaluator().run(options);
  if (result.kind !== "local") throw new Error("Expected a local result");
  expect(result.exitCode).toBe(0);
  expect(result.snapshot.run.taskIds).toEqual(["b"]);
  await released(root);
});

test("SDK resumes the same run and rebuilds a report without authentication", async () => {
  const { root, options } = await fixture();
  const sdk = new Evaluator();
  const first = await sdk.run(options);
  const events: ProgressEvent[] = [];
  const resumed = await sdk.run({ ...options, resume: true, onProgress: event => events.push(event) });
  expect(resumed.runDirectory).toBe(first.runDirectory);
  expect(events.some(event => event.phase === "solve")).toBe(false);
  expect(await sdk.report(first.runDirectory!)).toBe(first.reportPath);
  expect(await readFile(join(root, "lifecycle.log"), "utf8")).toBe("registered\ndisposed\nregistered\ndisposed\n");
});

test("SDK cancels a running attempt, saves its partial report and releases resources", async () => {
  const { root, options } = await fixture("cancel");
  const controller = new AbortController();
  const listeners = process.listenerCount("SIGINT");
  const result = await new Evaluator().run({ ...options, signal: controller.signal,
    onProgress(event) { if (event.phase === "solve") controller.abort(); } });
  expect(result.exitCode).toBe(130);
  if (result.kind !== "local") throw new Error("Expected local cancellation");
  expect(result.snapshot.run.status).toBe("cancelled");
  expect(await readFile(result.reportPath!, "utf8")).toContain("未完成");
  expect(process.listenerCount("SIGINT")).toBe(listeners);
  await released(root);
});

test("failed configuration releases the registry without creating a run", async () => {
  const { root, options } = await fixture();
  await expect(new Evaluator().run({ ...options, env: {} })).rejects.toMatchObject({
    name: "EvaluatorRunError", phase: "config", exitCode: 2, result: null,
  });
  await released(root);
  await expect(readdir(join(root, "results"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("source failure retains a readable partial result and redacts its causes", async () => {
  const { root, options } = await fixture("python-file-error");
  try { await new Evaluator().run(options); throw new Error("Expected failure"); }
  catch (error) {
    expect(error).toBeInstanceOf(EvaluatorRunError);
    if (!(error instanceof EvaluatorRunError)) throw error;
    expect(error.exitCode).toBe(2);
    expect(error.result?.kind).toBe("local");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain("FileNotFoundError");
    expect(await readFile(error.result!.reportPath!, "utf8")).toContain("FileNotFoundError");
  }
  await released(root);
});

test("report failure rejects with its partial result and is not retried", async () => {
  const { root, options } = await fixture("report-error");
  await expect(new Evaluator().run(options)).rejects.toMatchObject({
    phase: "report", exitCode: 1, result: { kind: "local", reportPath: null },
  });
  expect((globalThis as Record<string, unknown>).__cliReportCalls).toBe(1);
  await released(root);
});

test("progress callback failure still closes the store and registry", async () => {
  const { root, options } = await fixture("cancel");
  await expect(new Evaluator().run({ ...options, onProgress(event) {
    if (event.phase === "solve") throw new Error("observer failed SDK_SENSITIVE_TEST_VALUE");
  } })).rejects.toSatisfy((error: unknown) => error instanceof EvaluatorRunError
    && error.exitCode === 1 && !String(error.cause).includes("SDK_SENSITIVE_TEST_VALUE") && error.message.includes("observer failed"));
  await released(root);
});

test("dispose progress callback cannot prevent actual disposal", async () => {
  const { root, options } = await fixture();
  await expect(new Evaluator().run({ ...options, onProgress(event) {
    if (event.phase === "dispose") throw new Error("dispose observer failed");
  } })).rejects.toMatchObject({ phase: "dispose", exitCode: 1 });
  await released(root);
});

test("same SDK instance permits independent concurrent evaluations", async () => {
  const a = await fixture(), b = await fixture();
  const sdk = new Evaluator();
  const results = await Promise.all([sdk.run(a.options), sdk.run(b.options)]);
  expect(results.every(result => result.exitCode === 0)).toBe(true);
  expect(results[0]?.runDirectory).not.toBe(results[1]?.runDirectory);
  await released(a.root); await released(b.root);
});

test("rejected resume does not overwrite the original report", async () => {
  const { options } = await fixture();
  const sdk = new Evaluator();
  const first = await sdk.run(options);
  if (!first.reportPath) throw new Error("Missing first report");
  const before = await readFile(first.reportPath, "utf8");
  const config = await readFile(options.configPath, "utf8");
  await writeFile(options.configPath, config.replace('"model":"sdk-fixture"', '"model":"changed-model"'));
  await expect(sdk.run({ ...options, resume: first.runId ?? true })).rejects.toMatchObject({ exitCode: 2, result: null });
  expect(await readFile(first.reportPath, "utf8")).toBe(before);
});

test("component disposal failure still releases the shared registry", async () => {
  const { root, options } = await fixture();
  const original = assembly.bootstrap;
  vi.spyOn(assembly, "bootstrap").mockImplementation(async (...args) => {
    const components = await original(...args);
    const dispose = components.dispose;
    components.dispose = async () => { await dispose(); throw new Error("component release failed"); };
    return components;
  });
  await expect(new Evaluator().run(options)).rejects.toMatchObject({ phase: "dispose", exitCode: 1,
    message: "component release failed", result: { kind: "local" } });
  await released(root);
});

test("pre-aborted SDK call does not load plugins or start work", async () => {
  const { root, options } = await fixture();
  const signal = AbortSignal.abort(new Error("cancelled before start"));
  await expect(new Evaluator().run({ ...options, signal })).rejects.toMatchObject({ exitCode: 130, result: null });
  await expect(readFile(join(root, "lifecycle.log"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])("SDK selects Ray Jobs including managed local defaults=%s", async managed => {
  const { root, options } = await fixture("pass", { scheduler: { name: "ray", concurrency: 2 },
    ...(managed ? {} : { deployment: { kind: "ray-jobs", endpoint: "https://jobs.invalid", caFile: "cert.pem", managedLocal: false } }) });
  const events: ProgressEvent[] = [];
  const submitted = vi.spyOn(RayJobsDeployment.prototype, "runExperiment").mockImplementation(async (_config, _versions, opts) => {
    opts.log("remote progress SDK_SENSITIVE_TEST_VALUE");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return { exitCode: 0, jobId: "job", runId: "run", runDirectory: join(root, "downloaded"),
      reportPath: join(root, "downloaded/report.md"), collectionError: null, reportError: null };
  });
  const result = await new Evaluator().run({ ...options, onProgress: event => events.push(event) });
  expect(result).toMatchObject({ kind: "ray-jobs", jobId: "job", runId: "run", exitCode: 0 });
  expect(submitted).toHaveBeenCalledOnce();
  expect(events.some(event => event.phase === "deployment")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("SDK_SENSITIVE_TEST_VALUE");
  await released(root);
});

test("Ray collection failure remains an error with a redacted partial receipt", async () => {
  const { root, options } = await fixture("pass", { scheduler: { name: "ray" } });
  vi.spyOn(RayJobsDeployment.prototype, "runExperiment").mockResolvedValue({ exitCode: 0,
    jobId: "job", runId: "run", runDirectory: null, reportPath: null,
    collectionError: "download failed SDK_SENSITIVE_TEST_VALUE", reportError: null });
  await expect(new Evaluator().run(options)).rejects.toSatisfy((error: unknown) => error instanceof EvaluatorRunError
    && error.exitCode === 1 && error.phase === "collect" && error.result?.kind === "ray-jobs"
    && !JSON.stringify(error.result).includes("SDK_SENSITIVE_TEST_VALUE"));
  await released(root);
});
