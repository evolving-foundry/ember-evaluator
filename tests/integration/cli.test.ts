import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { runCli } from "../../src/cli/main.js";
import { loadPluginModule } from "../../src/application/plugins/load-module.js";
import { rebuildDownloadedReport } from "../../src/application/ray/deployment.js";
import type { JsonValue, RunManifest } from "../../src/index.js";

const roots: string[] = [];
beforeEach(() => { vi.stubEnv("EVALUATOR_DEBUG", ""); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  delete (globalThis as Record<string, unknown>).__cliEntered;
  delete (globalThis as Record<string, unknown>).__cliOnSolve;
  delete (globalThis as Record<string, unknown>).__cliOnPrepare;
  delete (globalThis as Record<string, unknown>).__cliOnSolverFactory;
  delete (globalThis as Record<string, unknown>).__cliReportCalls;
});
function output() {
  const stdout: string[] = []; const stderr: string[] = [];
  return { stdout, stderr, io: { out: (text: string) => { stdout.push(text); }, error: (text: string) => { stderr.push(text); } } };
}
async function savedRun(config: JsonValue = { model: { apiKey: "${MISSING_KEY}" } }, manifest: RunManifest = mixedSnapshot.run) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-cli-")); roots.push(root);
  const store = new LocalRunStore(); await store.create(root, manifest, config);
  for (const record of mixedSnapshot.records) {
    await store.allocate(record.key); await store.commit(record, { files: [], missing: [] });
  }
  await store.close(); return join(root, manifest.runId);
}

test("report rebuilds stored results without model authentication and preserves the digest", async () => {
  const runDir = await savedRun(); const { io, stdout, stderr } = output();
  expect(await runCli(["report", runDir], io)).toBe(0);
  const metrics = JSON.parse(await readFile(join(runDir, "metrics.json"), "utf8"));
  expect(metrics.metrics["success-rate"]).toMatchObject({ selected: 4, rate: 1 / 3 });
  const report = await readFile(join(runDir, "report.md"), "utf8");
  expect(report).toContain(metrics.snapshotDigest); expect(report).toContain("未完成");
  expect(stderr.join("\n")).toContain("[report]"); expect(stderr.join("\n")).not.toContain("ERROR"); expect(stdout.join("\n")).toContain("report.md");
  expect(await runCli(["report", runDir], io)).toBe(0);
  expect(await readFile(join(runDir, "metrics.json"), "utf8")).toBe(JSON.stringify(metrics, null, 2) + "\n");
});

test("offline built-in reports ignore unavailable unrelated inserted modules", async () => {
  const manifest: RunManifest = { ...mixedSnapshot.run,
    pluginRuntime: { configDirectory: import.meta.dirname, entries: [{ id: "unrelated-solver", name: "./does-not-exist.mjs" }] },
    pluginVersions: { "unrelated-solver": "saved-version", "ember-evaluator:builtin-runtime": `sha256:${"a".repeat(64)}` } };
  const runDir = await savedRun({}, manifest); const { io, stderr } = output();
  expect(await runCli(["report", runDir], io)).toBe(0); expect(stderr.join("\n")).not.toContain("ERROR");
});

test.each([
  ["unknown"],
  ["run"],
  ["report"],
  ["run", "x", "--unknown"],
  ["run", "x", "--log-format", "json"],
  ["run", "x", "--patch"],
  ["run", "x", "--patch", "one.yaml", "--patch", "two.yaml"],
  ["report", "x", "extra"],
])("invalid CLI %j returns usage error", async (...argv) => {
  const { io, stderr } = output(); expect(await runCli(argv, io)).toBe(2); expect(stderr.length).toBeGreaterThan(0);
});

test("help does not bootstrap an experiment", async () => {
  const { io, stdout } = output(); expect(await runCli(["--help"], io)).toBe(0);
  expect(stdout.join("\n")).toContain("run [options] <yaml>"); expect(stdout.join("\n")).toContain("report <run-dir>");
});

test("offline third-party reporting loads only selected report factories and checks locked versions", async () => {
  const directory = join(import.meta.dirname, "../fixtures/plugins/valid");
  const entry = { id: "fixture-seven-roles", name: "./plugin.mjs" };
  const resolved = await loadPluginModule(entry, join(directory, "cordis.patch.yaml"));
  const manifest: RunManifest = { ...mixedSnapshot.run, pluginRuntime: { configDirectory: directory,
    entries: [entry, { id: "unrelated-solver", name: "./does-not-exist.mjs" }],
    reportingProviders: { "metrics:fixture-metrics": entry.id, "reporter:fixture-reporter": entry.id } }, pluginVersions: { [entry.id]: resolved.version } };
  const configuration = { metrics: [{ name: "fixture-metrics", config: { marker: "metrics" } }], reporter: { name: "fixture-reporter", config: { marker: "reporter" } }, model: { apiKey: "${MISSING_KEY}" } };
  const runDir = await savedRun(configuration, manifest);
  delete (globalThis as Record<string, unknown>).__t02FixtureState;
  const { io, stderr } = output(); expect(await runCli(["report", runDir], io)).toBe(0);
  const state = (globalThis as Record<string, unknown>).__t02FixtureState as { created: string[]; factoryInputs: { auth: string }[] };
  expect(state.created).toEqual(["metrics", "reporter"]); expect(state.factoryInputs.every(input => input.auth === null)).toBe(true);
  expect(stderr.join("\n")).not.toContain("ERROR"); expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("fixture");
  const wrong = await savedRun(configuration, { ...manifest, pluginVersions: { [entry.id]: "different-version" } });
  expect(await runCli(["report", wrong], io)).toBe(1); expect(stderr.join("\n")).toMatch(/version/i);
});

test("offline third-party reports load their plugin from the saved explicit patch path", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-report-patch-")); roots.push(root);
  const configDirectory = join(root, "experiment");
  const patchDirectory = join(root, "plugins");
  await mkdir(configDirectory);
  await mkdir(patchDirectory);
  const fixture = join(import.meta.dirname, "../fixtures/plugins/valid");
  const pluginPath = join(patchDirectory, "plugin.mjs");
  const patchPath = join(patchDirectory, "cordis.patch.yaml");
  await copyFile(join(fixture, "plugin.mjs"), pluginPath);
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "fixture-seven-roles", name: "./plugin.mjs" }] }]));
  const entry = { id: "fixture-seven-roles", name: "./plugin.mjs" };
  const resolved = await loadPluginModule(entry, patchPath);
  const manifest: RunManifest = {
    ...mixedSnapshot.run,
    pluginRuntime: {
      configDirectory,
      patchPath: resolve(patchPath),
      entries: [entry],
      reportingProviders: {
        "metrics:fixture-metrics": entry.id,
        "reporter:fixture-reporter": entry.id,
      },
    },
    pluginVersions: { [entry.id]: resolved.version },
  };
  const configuration = {
    metrics: [{ name: "fixture-metrics", config: { marker: "metrics" } }],
    reporter: { name: "fixture-reporter", config: { marker: "reporter" } },
  };
  const runDir = await savedRun(configuration, manifest);
  delete (globalThis as Record<string, unknown>).__t02FixtureState;
  const { io, stderr } = output();

  expect(await runCli(["report", runDir], io)).toBe(0);

  const state = (globalThis as Record<string, unknown>).__t02FixtureState as { created: string[] };
  expect(state.created).toEqual(["metrics", "reporter"]);
  expect(stderr.join("\n")).not.toContain("ERROR");
  expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("fixture");
});

test("downloaded Ray Jobs reports use the submitter patch and retain coordinator provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-ray-report-patch-")); roots.push(root);
  const configDirectory = join(root, "experiment");
  const patchDirectory = join(root, "plugins");
  await mkdir(configDirectory);
  await mkdir(patchDirectory);
  const fixture = join(import.meta.dirname, "../fixtures/plugins/valid");
  const patchPath = join(patchDirectory, "cordis.patch.yaml");
  await copyFile(join(fixture, "plugin.mjs"), join(patchDirectory, "plugin.mjs"));
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "fixture-seven-roles", name: "./plugin.mjs" }] }]));
  const entry = { id: "fixture-seven-roles", name: "./plugin.mjs" };
  const resolved = await loadPluginModule(entry, patchPath);
  const manifest: RunManifest = {
    ...mixedSnapshot.run,
    pluginRuntime: {
      configDirectory: "/experiment",
      patchPath: "/experiment/cordis.patch.yaml",
      entries: [entry],
      reportingProviders: {
        "metrics:fixture-metrics": entry.id,
        "reporter:fixture-reporter": entry.id,
      },
    },
    pluginVersions: { [entry.id]: resolved.version },
  };
  const configuration = {
    metrics: [{ name: "fixture-metrics", config: { marker: "metrics" } }],
    reporter: { name: "fixture-reporter", config: { marker: "reporter" } },
  };
  const runDir = await savedRun(configuration, manifest);
  const { io, stderr } = output();

  await rebuildDownloadedReport(runDir, { configDirectory, pluginPatchPath: resolve(patchPath) });

  const downloaded = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as RunManifest;
  expect(downloaded.pluginRuntime?.configDirectory).toBe(configDirectory);
  expect(downloaded.pluginRuntime?.coordinatorConfigDirectory).toBe("/experiment");
  expect(downloaded.pluginRuntime?.patchPath).toBe(resolve(patchPath));
  expect(downloaded.pluginRuntime?.coordinatorPatchPath).toBe("/experiment/cordis.patch.yaml");
  expect(await runCli(["report", runDir], io)).toBe(0);
  expect(stderr.join("\n")).not.toContain("ERROR");
  expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("fixture");
});

async function experiment(mode: string, options: { tasks?: string[]; run?: Record<string, unknown>; omitModelApiKey?: boolean; missingModelApiKeyEnv?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-cli-run-")); roots.push(root);
  vi.stubEnv("CLI_FIXTURE_KEY", "SENSITIVE_FOR_TEST_ONLY");
  const config = {
    services: { default: { model: "fixture", base_url: "https://fixture.invalid", api: "openai-completions", ...(options.missingModelApiKeyEnv ? { api_key: `\${${options.missingModelApiKeyEnv}}` } : options.omitModelApiKey ? {} : { api_key: "${CLI_FIXTURE_KEY}" }) } },
    benchmark: { name: "cli-fixture", config: { mode, ...(options.tasks === undefined ? {} : { tasks: options.tasks }) }, solver: { name: "cli-fixture", service: "default", config: { mode } } }, environment: { name: "local" },
    run: { onError: "abort", ...options.run },
    ...(mode === "report-error" ? { reporter: { name: "cli-error" } } : {}), output: { directory: "./runs" },
  };
  const file = join(root, "run.yaml"); await writeFile(file, JSON.stringify(config));
  const patchDirectory = join(root, "patches");
  await mkdir(patchDirectory);
  await writeFile(join(patchDirectory, "cordis.patch.yaml"), JSON.stringify([{ insert: [{ id: "cli-fixture", name: join(import.meta.dirname, "../fixtures/cli/plugin.mjs") }] }]));
  return { root, file, patchFile: join(patchDirectory, "cordis.patch.yaml") };
}

function runArgs(file: string, ...options: string[]): string[] {
  return ["run", file, "--patch", join(dirname(file), "patches", "cordis.patch.yaml"), ...options];
}

test("default usage errors show CONFIG_INVALID and an explanation", async () => {
  const invalid = output();
  expect(await runCli(["run"], invalid.io)).toBe(2);
  expect(invalid.stderr.join("\n")).toContain("CONFIG_INVALID");
  expect(invalid.stderr.join("\n")).toContain("Check configuration, plugins and runtime dependencies");
});

test("CLI dry-run lists the selected task IDs without model auth or creating a run", async () => {
  const { root, file } = await experiment("pass", { tasks: ["a", "b", "c"], run: { taskIds: ["c", "a"], offset: 1, maxTasks: 1 }, missingModelApiKeyEnv: "MISSING_MODEL_KEY" });
  const { io, stdout, stderr } = output(); let solveCalls = 0; let prepareCalls = 0; let solverFactoryCalls = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { solveCalls++; };
  (globalThis as Record<string, unknown>).__cliOnPrepare = () => { prepareCalls++; };
  (globalThis as Record<string, unknown>).__cliOnSolverFactory = () => { solverFactoryCalls++; };

  expect(await runCli(runArgs(file, "--dry-run"), io), stderr.join("\n")).toBe(0);

  expect(stdout).toEqual(['{"taskIds":["c"]}']);
  expect(solveCalls).toBe(0);
  expect(prepareCalls).toBe(0);
  expect(solverFactoryCalls).toBe(0);
  expect(stderr.join("\n")).not.toContain("[solve]");
  await expect(readdir(join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

test("CLI resolves a relative --patch path from the current working directory", async () => {
  const { file, patchFile } = await experiment("pass", { tasks: ["a"] });
  const { io, stdout } = output();

  expect(await runCli(["run", file, "--dry-run", "--patch", relative(process.cwd(), patchFile)], io)).toBe(0);
  expect(stdout).toEqual(['{"taskIds":["a"]}']);
});

test("CLI dry-run uses an explicit task ID file without sampling or truncating", async () => {
  const { root, file } = await experiment("pass", {
    tasks: ["a", "b", "c"],
    run: { taskIds: ["b"], offset: 2, maxTasks: 1, sampling: { strategy: "random", seed: 41 } },
  });
  const taskIdsFile = join(root, "held-in.json");
  await writeFile(taskIdsFile, JSON.stringify({ taskIds: ["c", "a"] }));
  const { io, stdout } = output();

  expect(await runCli(runArgs(file, "--dry-run", "--task-ids-file", taskIdsFile), io)).toBe(0);

  expect(stdout).toEqual(['{"taskIds":["a","c"]}']);
  await expect(readdir(join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("CLI run stores the explicit task set despite YAML filters", async () => {
  const { root, file } = await experiment("pass", {
    tasks: ["a", "b", "c"],
    run: { taskIds: ["b"], offset: 2, maxTasks: 1, sampling: { strategy: "random", seed: 41 } },
  });
  const taskIdsFile = join(root, "held-in.json");
  await writeFile(taskIdsFile, JSON.stringify({ taskIds: ["c", "a"] }));
  const { io, stderr } = output();

  expect(await runCli(runArgs(file, "--task-ids-file", taskIdsFile), io), stderr.join("\n")).toBe(0);

  const [runId] = await readdir(join(root, "runs"));
  const manifest = JSON.parse(await readFile(join(root, "runs", runId!, "manifest.json"), "utf8")) as RunManifest;
  expect(manifest.taskIds).toEqual(["a", "c"]);
});

test.each([
  ["empty", { taskIds: [] }],
  ["duplicate", { taskIds: ["a", "a"] }],
])("CLI dry-run rejects %s task ID lists", async (_label, contents) => {
  const { root, file } = await experiment("pass", { tasks: ["a", "b"] });
  const taskIdsFile = join(root, "invalid-task-ids.json");
  await writeFile(taskIdsFile, JSON.stringify(contents));
  const { io, stdout, stderr } = output();

  expect(await runCli(runArgs(file, "--dry-run", "--task-ids-file", taskIdsFile), io)).toBe(2);

  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toMatch(/taskIds|task ID/i);
});

test("CLI dry-run rejects malformed task ID JSON and unknown IDs", async () => {
  const { root, file } = await experiment("pass", { tasks: ["a", "b"] });
  const taskIdsFile = join(root, "task-ids.json");
  const { io, stdout, stderr } = output();

  await writeFile(taskIdsFile, "{");
  expect(await runCli(runArgs(file, "--dry-run", "--task-ids-file", taskIdsFile), io)).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toMatch(/valid JSON/);

  await writeFile(taskIdsFile, JSON.stringify({ taskIds: ["missing"] }));
  expect(await runCli(runArgs(file, "--dry-run", "--task-ids-file", taskIdsFile), io)).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toMatch(/task ID|task id|unknown|not found/i);
});

test("ordinary run still requires model authentication", async () => {
  const { file } = await experiment("pass", { omitModelApiKey: true }); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(2);
  expect(stderr.join("\n")).toContain("model.apiKey");
});

test("CLI dry-run rejects resume and documents patch selection", async () => {
  const { io, stdout, stderr } = output();
  expect(await runCli(["run", "--help"], io)).toBe(0);
  expect(stdout.join("\n")).toContain("--dry-run");
  expect(stdout.join("\n")).toContain("--patch");
  expect(await runCli(["run", "x.yaml", "--dry-run", "--resume"], io)).toBe(2);
  expect(stderr.join("\n")).toContain("--resume");
});

test("CLI does not discover a cordis.patch.yaml beside the experiment without --patch", async () => {
  const { root, file } = await experiment("pass", { tasks: ["a"] });
  const patch = await readFile(join(root, "patches", "cordis.patch.yaml"), "utf8");
  await writeFile(join(root, "cordis.patch.yaml"), patch);
  const { io, stdout, stderr } = output();

  expect(await runCli(["run", file, "--dry-run"], io)).toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr.join("\n")).toContain("cli-fixture");
});

test.each([["pass", 0], ["wrong", 0], ["error", 1], ["unsupported", 1], ["report-error", 1]] as const)("CLI %s exits %i and preserves results", async (mode, code) => {
  const { root, file, patchFile } = await experiment(mode); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(code);
  const [runId] = await readdir(join(root, "runs")); const runDir = join(root, "runs", runId!);
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as RunManifest;
  expect(manifest.pluginRuntime?.patchPath).toBe(resolve(patchFile));
  expect(JSON.stringify(manifest)).toContain("cli-fixture");
  expect(await readFile(join(runDir, "config.yaml"), "utf8")).not.toContain("SENSITIVE_FOR_TEST_ONLY");
  expect(stderr.join("\n")).not.toContain("SENSITIVE_FOR_TEST_ONLY");
  if (mode !== "report-error") expect(await readFile(join(runDir, "report.md"), "utf8")).not.toContain("SENSITIVE_FOR_TEST_ONLY");
  else expect((globalThis as Record<string, unknown>).__cliReportCalls).toBe(1);
});

test("CLI cancellation returns130 and still saves a partial report", async () => {
  const { root, file } = await experiment("cancel"); const { io } = output();
  const entered = Promise.withResolvers<void>(); (globalThis as Record<string, unknown>).__cliEntered = entered.resolve;
  const controller = new AbortController(); const result = runCli(runArgs(file), io, controller.signal);
  await entered.promise; controller.abort(); expect(await result).toBe(130);
  const [runId] = await readdir(join(root, "runs"));
  expect(await readFile(join(root, "runs", runId!, "report.md"), "utf8")).toContain("未完成");
});

test("CLI reports source preparation failures with the network cause before any model execution", async () => {
  const { file } = await experiment("source-error", { run: { } }); const { io, stdout, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(1);
  const diagnostic = stderr.join("\n");
  expect(diagnostic).not.toContain("[config]");
  expect(diagnostic).not.toContain("[bootstrap]");
  expect(diagnostic).toContain("[source]");
  expect(diagnostic).toContain("cli-fixture");
  expect(diagnostic).toContain("fetch failed");
  expect(diagnostic).toContain("ECONNRESET");
  expect(diagnostic).toContain("huggingface.co");
  expect(diagnostic).toContain("--network");
  expect(diagnostic).not.toContain("[solve]");
  expect(stdout).toHaveLength(1);
});

test("CLI does not mistake Python FileNotFoundError for a network error", async () => {
  const { file } = await experiment("python-file-error"); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(2);
  expect(stderr.join("\n")).toContain("FileNotFoundError");
  expect(stderr.join("\n")).not.toContain("Check connectivity");
});

test("CLI streams task phases before solve finishes and leaves stdout usable as a result path", async () => {
  const { root, file } = await experiment("cancel"); const { io, stdout, stderr } = output();
  const entered = Promise.withResolvers<void>(); (globalThis as Record<string, unknown>).__cliEntered = entered.resolve;
  const controller = new AbortController(); const running = runCli(runArgs(file), io, controller.signal);
  await entered.promise;
  const duringSolve = stderr.join("\n");
  controller.abort(); expect(await running).toBe(130);
  expect(duringSolve).toContain("[info] [prepare] Task 1/1 task=task Preparing task");
  expect(duringSolve).toContain("[environment]");
  expect(duringSolve).toContain("[solve]");
  expect(duringSolve).toContain("task=task");
  expect(duringSolve).not.toContain("attempt=");
  expect(stderr.join("\n")).toContain("[report]");
  expect(stderr.join("\n")).not.toContain("[dispose]");
  const [runId] = await readdir(join(root, "runs"));
  expect(stdout).toEqual([join(root, "runs", runId!)]);
});

test("CLI prints failed attempt phase and nested cause with credentials redacted in logs and records", async () => {
  const { root, file } = await experiment("nested-error", { run: { } }); const { io, stdout, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(1);
  const diagnostic = stderr.join("\n");
  expect(diagnostic).toContain("NETWORK_FAILURE");
  expect(diagnostic).toContain("[network/request]");
  expect(diagnostic).not.toMatch(/\p{Script=Han}/u);
  expect(diagnostic).toContain("Network operation failed.");
  expect(diagnostic).toContain("[solve]");
  expect(diagnostic).toContain("task=task");
  expect(diagnostic).toContain("ECONNREFUSED");
  expect(diagnostic).toContain("[redacted]");
  expect(diagnostic).not.toContain("INTERNAL_STACK_FRAME");
  expect([...stdout, ...stderr].join("\n")).not.toContain("SENSITIVE_FOR_TEST_ONLY");
  const [runId] = await readdir(join(root, "runs")); const store = new LocalRunStore();
  expect(stdout).toEqual([join(root, "runs", runId!)]);
  try {
    await store.open(join(root, "runs", runId!));
    const snapshot = await store.snapshot();
    expect(snapshot.records[0]?.errors[0]?.causes).toContainEqual(expect.objectContaining({ code: "ECONNREFUSED" }));
    expect(JSON.stringify(snapshot)).not.toContain("SENSITIVE_FOR_TEST_ONLY");
  } finally { await store.close(); }
});

test("CLI stdout remains the real result path when a dummy key overlaps a directory name", async () => {
  const { root, file } = await experiment("pass"); const { io, stdout } = output();
  expect(await runCli(runArgs(file, "--api-key", "cli"), io)).toBe(0);
  const [runId] = await readdir(join(root, "runs"));
  expect(stdout).toEqual([join(root, "runs", runId!)]);
});

test.each(["", "0", "false"])("CLI info progress hides implementation details when EVALUATOR_DEBUG=%j", async value => {
  vi.stubEnv("EVALUATOR_DEBUG", value);
  const { file } = await experiment("pass"); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(0);
  const text = stderr.join("\n");
  for (const phase of ["source", "prepare", "environment", "solve", "verify", "report"]) expect(text).toContain(`[${phase}]`);
  for (const phase of ["config", "bootstrap", "enumerate", "store", "cleanup", "collect", "finalize", "dispose"]) expect(text).not.toContain(`[${phase}]`);
  expect(text).not.toContain("attempt=");
  expect(text).toContain("Task 1/1");
  expect(text).not.toMatch(/\p{Script=Han}/u);
});

test("CLI debug progress restores diagnostic details without exposing credentials", async () => {
  vi.stubEnv("EVALUATOR_DEBUG", "1");
  const { file } = await experiment("pass"); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(0);
  const text = stderr.join("\n");
  for (const phase of ["config", "bootstrap", "enumerate", "store", "prepare", "cleanup", "collect", "dispose"]) expect(text).toContain(`[${phase}]`);
  expect(text).toContain("[debug]");
  expect(text).toContain("attempt=");
  expect(text).not.toContain("SENSITIVE_FOR_TEST_ONLY");
});

test("CLI debug includes full error details while info retains the failure cause", async () => {
  vi.stubEnv("EVALUATOR_DEBUG", "1");
  const { file } = await experiment("nested-error", { run: { } }); const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(1);
  const text = stderr.join("\n");
  expect(text).toContain("INTERNAL_STACK_FRAME");
  expect(text).toContain("ECONNREFUSED");
  expect(text).not.toContain("SENSITIVE_FOR_TEST_ONLY");
});

test("CLI Agent deadline exits zero, persists its classification and rebuilds a zero-score report offline", async () => {
  const { root, file } = await experiment("cancel", { run: { timeoutSeconds: 1, } });
  const { io, stdout, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(0);
  const runDirectory = stdout[0]!;
  expect(runDirectory.startsWith(root)).toBe(true);
  expect(stderr.join("\n")).toContain("timeout (agent); score=0");
  expect(stderr.join("\n")).not.toContain("[error] [solve]");
  const store = new LocalRunStore();
  try {
    await store.open(runDirectory);
    expect(await store.listAttempts()).toHaveLength(1);
    expect((await store.snapshot()).records[0]).toMatchObject({ executionStatus: "agent_timeout", verdict: null });
  } finally { await store.close(); }
  expect(await runCli(["report", runDirectory], output().io)).toBe(0);
  const report = await readFile(join(runDirectory, "report.md"), "utf8");
  expect(report).toContain("| task | timeout (agent) | 0 |");
  expect(report).toContain("| 计分题数 | 1 |");
});

test("standalone CLI exits zero after automatic task recovery", async () => {
  const { root, file } = await experiment("transient", { run: { } });
  const { io, stderr } = output();
  expect(await runCli(runArgs(file), io)).toBe(0);
  expect(stderr.join("\n")).toContain("[retry]");
  const [runId] = await readdir(join(root, "runs"));
  const store = new LocalRunStore();
  try {
    await store.open(join(root, "runs", runId!));
    expect((await store.listAttempts()).map(attempt => attempt.record?.executionStatus)).toEqual(["failed", "completed"]);
    expect((await store.snapshot()).run.status).toBe("completed");
  } finally { await store.close(); }
});

test("standalone CLI exits nonzero after exhausting automatic task recovery", async () => {
  const { root, file } = await experiment("pass");
  const { io } = output();
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { throw new Error("Response payload is not completed"); };
  expect(await runCli(runArgs(file), io)).toBe(1);
  const [runId] = await readdir(join(root, "runs"));
  const store = new LocalRunStore();
  try {
    await store.open(join(root, "runs", runId!));
    expect((await store.listAttempts()).map(attempt => attempt.record?.executionStatus)).toEqual(["failed", "failed", "failed"]);
    expect((await store.snapshot()).run.status).toBe("error");
  } finally { await store.close(); }
});


test("resume CLI creates a report directory and retry updates it while preserving previous reports", async () => {
  const { root, file } = await experiment("pass", { tasks: ["a"],
    run: { onError: "continue", } });
  const { io, stderr } = output(); let fail = true;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { if (fail) throw new Error("ECONNRESET"); };
  expect(await runCli(runArgs(file), io), stderr.join("\n")).toBe(1);
  const [runId] = await readdir(join(root, "runs"));
  const directory = join(root, "runs", runId!);
  expect(await readdir(directory)).not.toContain("reports");
  expect(await runCli(runArgs(file, "--resume", runId!), io), stderr.join("\n")).toBe(1);
  const initial = await readFile(join(directory, "reports/initial/report.md"), "utf8");
  const resumed = await readFile(join(directory, "reports/resume-1/report.md"), "utf8");
  expect(initial).toContain("NETWORK_FAILURE");
  expect(resumed).toContain("NETWORK_FAILURE");
  fail = false;
  expect(await runCli(["retry", "--run", runId!, "--request-id", "resumed-recovery"], io), stderr.join("\n")).toBe(0);
  expect(await readFile(join(directory, "reports/initial/report.md"), "utf8")).toBe(initial);
  expect(await readFile(join(directory, "reports/resume-1/report.md"), "utf8")).not.toContain("NETWORK_FAILURE");
  expect((await readdir(join(directory, "reports"))).sort()).toEqual(["current.json", "initial", "resume-1"]);
  expect(await runCli(["report", directory], io), stderr.join("\n")).toBe(0);
  expect((await readdir(join(directory, "reports"))).sort()).toEqual(["current.json", "initial", "resume-1"]);
  expect(await runCli(runArgs(file, "--resume", runId!), io), stderr.join("\n")).toBe(0);
  expect(await readdir(join(directory, "reports"))).toContain("resume-2");
});

test("retry CLI keeps the original run, rebinds environment auth and is idempotent", async () => {
  vi.stubEnv("TEST_RETRY_MODEL_KEY", "fixture-key");
  const { root, file } = await experiment("pass", { tasks: ["a"], missingModelApiKeyEnv: "TEST_RETRY_MODEL_KEY",
    run: { onError: "continue", } });
  const { io, stdout, stderr } = output(); let calls = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { if (++calls === 1) throw new Error("ECONNRESET"); };
  expect(await runCli(runArgs(file), io), stderr.join("\n")).toBe(1);
  const [runId] = await readdir(join(root, "runs")); const directory = join(root, "runs", runId!);
  expect(await runCli(["retry", "--run", runId!, "--request-id", "cli-recovery"], io), stderr.join("\n")).toBe(0);
  expect(calls).toBe(2);
  expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).status).toBe("completed");
  expect(await readFile(join(directory, "report.md"), "utf8")).not.toContain("NETWORK_FAILURE");
  expect(await readdir(directory)).not.toContain("reports");
  expect(await runCli(["retry", "--run", runId!, "--request-id", "cli-recovery"], io)).toBe(0);
  expect(calls).toBe(2);
  expect(stdout.some(line => line.includes(runId!))).toBe(true);
});
