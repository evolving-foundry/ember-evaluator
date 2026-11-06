import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig, loadSavedConfig } from "../../src/application/config.js";
import { exportConfig } from "../../src/config/export.js";
import { explainConfig } from "../../src/config/explain.js";
import { bootstrap, createPluginRuntime } from "../../src/application/plugins/bootstrap.js";
import { runCli } from "../../src/cli/main.js";
import { parseUserConfig } from "../../src/config/user-schema.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { parseConfigProfile } from "../../src/config/profile-schema.js";
import { assertJsonValue } from "../../src/core/validation/input.js";
import { fingerprintConfig, fingerprintResumeConfig } from "../../src/core/results/run-manifest.js";
import { projectRemoteJob, validateRemoteJob } from "../../src/infrastructure/ray/protocol.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { rebuildReport } from "../../src/application/report/index.js";

const roots: string[] = [];
const services = { default: { model: "fixture/model", base_url: "http://127.0.0.1:8000/v1", api_key: "${HARDWARE_TEST_KEY}" } };
const env = { ...process.env, HARDWARE_TEST_KEY: "fixture-key" };
function resumeFingerprint(value: unknown): string { assertJsonValue(value); return fingerprintResumeConfig(value); }
function fingerprint(value: unknown): string { assertJsonValue(value); return fingerprintConfig(value); }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function configFile(value: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "hardware-config-")); roots.push(root);
  const file = join(root, "experiment.yaml");
  await writeFile(file, stringify({ services, benchmark: "agentx", ...value }));
  return { root, file };
}

test.each([undefined, "npu", "gpu"])("hardware %s survives loading, export, persistence and plugin creation", async hardware => {
  const { root, file } = await configFile(hardware === undefined ? {} : { hardware });
  const config = await loadConfig(file, {}, env);
  const expected = hardware ?? "npu";
  expect(config.experiment.hardware).toBe(expected);
  expect(createPluginRuntime(config, root).hardware).toBe(expected);
  expect(explainConfig(config)).toContain(`hardware: "${expected}"  [${hardware === undefined ? "framework default" : "user YAML"}]`);
  const exported = join(root, "export.yaml"), saved = join(root, "saved.yaml");
  await writeFile(exported, stringify(exportConfig(config)));
  await writeFile(saved, stringify(config.persisted));
  expect((await loadConfig(exported, {}, env)).experiment.hardware).toBe(expected);
  expect((await loadSavedConfig(saved, env)).experiment.hardware).toBe(expected);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
  const components = await bootstrap(config, root);
  await components.dispose();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([null, "GPU", "cuda", "cpu", "", 0, {}, []])("rejects invalid hardware %j", hardware => {
  expect(() => parseUserConfig({ services, benchmark: "agentx", hardware })).toThrow("hardware must be npu or gpu");
});

test("Profile hardware defaults apply unless overridden by YAML", () => {
  const profile = parseConfigProfile({ id: "fixture", role: "benchmark", defaults: { hardware: "gpu" } });
  expect(resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture" }), [profile]).hardware).toBe("gpu");
  expect(resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture", hardware: "npu" }), [profile]).hardware).toBe("npu");
});

test("historical NPU config fingerprint is preserved; GPU cannot resume it", async () => {
  const { root, file } = await configFile({});
  const loaded = await loadConfig(file, {}, env);
  const historical = { ...loaded.experiment, services: { default: { ...loaded.experiment.services.default, apiKey: "${HARDWARE_TEST_KEY}" } } };
  delete historical.hardware;
  const { output: _output, ...original } = historical;
  expect(resumeFingerprint(historical)).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "npu" })).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "gpu" })).not.toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "npu", network: { benchmarkName: "fixture", template: {} } })).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "gpu", network: { benchmarkName: "fixture", template: {} } }))
    .toBe(resumeFingerprint({ ...historical, hardware: "gpu" }));
  const saved = join(root, "old.yaml"); await writeFile(saved, stringify(historical));
  expect((await loadSavedConfig(saved, env)).experiment.hardware).toBe("npu");
});

test.each(["npu", "gpu"] as const)("Ray job preserves %s and rejects invalid wire values", async hardware => {
  const config = resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture", hardware }), []);
  const network = { benchmarkName: "fixture", template: { sources: { huggingface: "https://hf.example" } } };
  const job = projectRemoteJob({ config, network,
    job: { runId: "run", taskId: "task", attemptId: "attempt", ref: { id: "task", recordKey: "task" }, configFingerprint: "config" },
    run: { runId: "run", configFingerprint: "config", pluginVersions: {}, source: { source: "fixture", revision: "1", files: [], metadata: {} } },
    packageDigest: `sha256:${"a".repeat(64)}`, uploadEndpoint: "https://collector.invalid", previousAttempts: [] });
  const restored = validateRemoteJob(JSON.parse(JSON.stringify(job)));
  expect(restored.safeConfig.hardware).toBe(hardware);
  expect(restored.safeConfig.network).toEqual(network);
  expect(() => validateRemoteJob({ ...job, safeConfig: { ...job.safeConfig, hardware: "cuda" } })).toThrow("hardware");
  const old = structuredClone(job); delete old.safeConfig.hardware;
  expect(validateRemoteJob(old).safeConfig.hardware).toBeUndefined();
});

test("historical run without hardware rebuilds its report offline", async () => {
  const { root } = await configFile({});
  const runId = randomUUID(), store = new LocalRunStore();
  const saved = { metrics: [{ name: "duration", config: {} }], reporter: { name: "markdown", config: {} } };
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
  try {
    await store.create(root, { schemaVersion: 1, evaluationKind: "quality", runId, source: null, taskIds: [],
      configFingerprint: fingerprint(saved), pluginVersions: {}, startedAt: new Date().toISOString(),
      finishedAt: null, durationMs: null, status: "cancelled" }, saved);
  } finally { await store.close(); }
  await rebuildReport(join(root, runId));
  expect(await readFile(join(root, runId, "report.md"), "utf8")).toContain(runId);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  ["playbook/kernel/existing.yaml", "npu"],
  ["playbook/agentx/agentx-gpu-api.yaml", "gpu"],
] as const)("hardware example %s resolves without hardware or model access", async (file, hardware) => {
  const loaded = await loadConfig(file, {}, { ...env, MODEL_NAME: "fixture/model", MODEL_ENDPOINT: "http://127.0.0.1:8000/v1",
    MODEL_API_KEY: "fixture-key", KERNEL_MANIFEST: "missing.json", KERNEL_EVAL_PYTHON: "python", KERNEL_EVAL_PLACEHOLDER: "unused" });
  expect(loaded.experiment.hardware).toBe(hardware);
  const components = await bootstrap(loaded, process.cwd());
  await components.dispose();
});

test.each([undefined, { vllm: { endpoint: "http://127.0.0.1:8000/metrics" } }])("GPU AgentX supports API replay and engine telemetry %j", async telemetry => {
  const { root, file } = await configFile({ hardware: "gpu", benchmark: { name: "agentx", solver: { config: telemetry ? { telemetry } : {} } } });
  const loaded = await loadConfig(file, {}, env);
  const components = await bootstrap(loaded, root);
  await components.dispose();
});

test.each([
  { name: "kernel", config: { manifest: "missing.json" } },
  { name: "agentx", solver: { config: { telemetry: { ascend: { mode: "local", devices: [{ deviceId: 0 }] } } } } },
  { name: "agentx", solver: { config: { telemetry: { ascend: { endpoint: "http://127.0.0.1:9999/metrics", deviceId: 0, chipId: 0 } } } } },
])("GPU rejects unsupported combination before source/model/device work: %j", async benchmark => {
  const { file } = await configFile({ hardware: "gpu", benchmark });
  vi.stubEnv("HARDWARE_TEST_KEY", "fixture-key");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  for (const args of [["doctor", file], ["run", file, "--dry-run"], ["run", file]]) {
    const messages: string[] = [];
    const code = await runCli(args, { out: message => { messages.push(message); }, error: message => { messages.push(message); } });
    expect(code).not.toBe(0);
    expect(messages.join("\n")).toMatch(/Kernel GPU backend is not implemented|telemetry.ascend requires hardware=npu/);
    expect(messages.join("\n")).not.toContain("ENOENT");
  }
  expect(fetch).not.toHaveBeenCalled();
});
