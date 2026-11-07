import "../fixtures/network-fetch.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/index.js";
import { officeQAScoringProgram } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/runtime.js";
import { HuggingFaceSnapshotSource } from "../../src/infrastructure/datasets/sources/huggingface/snapshot-source.js";
import { OFFICEQA_DATASET_REVISION } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/config.js";
import { officeQAFiles, officeQAHub, fixtureCSV } from "../fixtures/officeqa.js";
import { loadConfig, loadSavedConfig } from "../../src/application/config.js";
import { exportConfig } from "../../src/config/export.js";
import { stringify } from "yaml";
import { bootstrapBenchmark } from "../../src/application/plugins/bootstrap.js";
import { runCli } from "../../src/cli/main.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { localizePortableSelection, validatePortableSelection } from "../../src/infrastructure/ray/protocol.js";

const roots: string[] = [];
const hubs: Awaited<ReturnType<typeof officeQAHub>>[] = [];
const signal = () => AbortSignal.timeout(10_000);
async function root() { const path = await mkdtemp(join(tmpdir(), "officeqa-unit-")); roots.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(hubs.splice(0).map(hub => hub.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("OfficeQA configuration rejects unknown, unpinned and invalid fields", () => {
  expect(parseOfficeQAProV2Config({})).toMatchObject({ corpusFormat: "parsed-json", tolerance: 0, revision: OFFICEQA_DATASET_REVISION });
  expect(parseOfficeQAProV2Config({})).not.toHaveProperty("hfTokenEnv");
  expect(() => parseOfficeQAProV2Config({ hfTokenEnv: "HF_TOKEN" })).toThrow(/unknown field hfTokenEnv/);
  expect(() => parseOfficeQAProV2Config({ hfToken: "explicit-token", hfTokenEnv: "HF_TOKEN" })).toThrow(/unknown field hfTokenEnv/);
  for (const config of [{ corpusFormat: "txt" }, { revision: "main" }, { tolerance: -0.1 }, { tolerance: 1.1 }, { tolerance: NaN }, { tolerance: "0" }, { hfToken: "" }, { hfToken: 123 }, { extra: true }])
    expect(() => parseOfficeQAProV2Config(config)).toThrow();
});

test.each([
  ["officeqa-pro-v2-parsed-json-simpleagent.yaml", "parsed-json", "local"],
  ["officeqa-pro-v2-parsed-json-full.yaml", "parsed-json", "local"],
  ["officeqa-pro-v2-parsed-json-ray.yaml", "parsed-json", "ray"],
  ["officeqa-pro-v2-original-pdf.yaml", "pdf", "local"],
] as const)("%s loads its document format and all tasks", async (file, format, scheduler) => {
  const env = { MODEL_NAME: "fixture/model", MODEL_ENDPOINT: "https://model.invalid", MODEL_API_KEY: "fixture-model-key", HF_TOKEN: "fixture-dataset-token" };
  const { experiment } = await loadConfig(resolve("playbook/officeqa-pro-v2", file), {}, env);
  expect(experiment.benchmark.config.corpusFormat).toBe(format);
  expect(experiment.run).toMatchObject({ maxTasks: null, taskIds: null });
  expect(experiment.scheduler.name).toBe(scheduler);
  expect(experiment.output.directory).toContain(format === "pdf" ? "original-pdf" : "parsed-json");
});

test("YAML hfToken uses SDK env and preserves references across save, export and credential rotation", async () => {
  const directory = await root();
  const file = join(directory, "experiment.yaml");
  const fixture = await officeQAFiles(join(directory, "source"), "parsed-json");
  const hub = await officeQAHub(fixture.bytes); hubs.push(hub);
  vi.stubEnv("HF_ENDPOINT", hub.endpoint); vi.stubEnv("HF_TOKEN", "unrelated-host-token");
  await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${MODEL_KEY}" } },
    benchmark: { name: "officeqa-pro-v2", config: { hfToken: "${SDK_HF_TOKEN}", cacheDir: join(directory, "cache") } } }));
  const networkConfigPath = join(directory, "network.yaml");
  await writeFile(networkConfigPath, stringify({ sources: { huggingface: hub.endpoint } }));
  const env = { EVALUATOR_NETWORK_CONFIG: networkConfigPath, MODEL_KEY: "model-secret", SDK_HF_TOKEN: "sdk-dataset-secret" };
  const loaded = await loadConfig(file, {}, env);
  expect(loaded.experiment.benchmark.config.hfToken).toBe("sdk-dataset-secret");
  expect(JSON.stringify(loaded.persisted)).toContain("${SDK_HF_TOKEN}");
  expect(JSON.stringify(loaded.persisted)).not.toContain("sdk-dataset-secret");
  const exported = exportConfig(loaded);
  expect(JSON.stringify(exported)).toContain("${SDK_HF_TOKEN}");
  expect(JSON.stringify(exported)).not.toContain("sdk-dataset-secret");
  const saved = join(directory, "saved.yaml"); await writeFile(saved, stringify(loaded.persisted));
  const rotated = await loadSavedConfig(saved, { ...env, SDK_HF_TOKEN: "rotated-secret" });
  expect(rotated.experiment.benchmark.config.hfToken).toBe("rotated-secret");
  expect(rotated.persisted).toEqual(loaded.persisted);
  await expect(loadConfig(file, {}, { MODEL_KEY: "model-secret" })).rejects.toThrow(/SDK_HF_TOKEN/);
  await expect(loadConfig(file, {}, { ...env, SDK_HF_TOKEN: "" })).rejects.toThrow(/hfToken/);
  const components = await bootstrapBenchmark(loaded, directory);
  try {
    // The tiny Hub has two documents rather than 1,435. Only authentication is under test.
    await expect(components.benchmark.resolveSource(null, signal())).rejects.toThrow(/file count/);
    expect(hub.authorizations.length).toBeGreaterThan(0);
    expect(hub.authorizations.every(value => value === "Bearer sdk-dataset-secret")).toBe(true);
  } finally { await components.dispose(); }
});

test("Ray nodes authenticate with their own fixed HF_TOKEN after explicit credentials are stripped", async () => {
  const directory = await root(); const fixture = await officeQAFiles(join(directory, "source"), "parsed-json");
  const hub = await officeQAHub(fixture.bytes); hubs.push(hub);
  vi.stubEnv("HF_ENDPOINT", hub.endpoint); vi.stubEnv("HF_TOKEN", "node-dataset-token");
  const registry = await openPluginRegistry();
  try {
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    const { projectPortableSelection } = await import("../../src/infrastructure/ray/protocol.js");
    const portable = projectPortableSelection({ name: "officeqa-pro-v2", config: { hfToken: "coordinator-token" } }, "benchmark", lookup);
    const selection = localizePortableSelection(portable, "benchmark", { outputRoot: directory }, lookup);
    const config = parseOfficeQAProV2Config(selection.config);
    expect(config).not.toHaveProperty("hfTokenEnv"); expect(config.hfToken).toBeUndefined();
    const benchmark = new OfficeQAProV2Benchmark(config, undefined, { questions: 2, documents: 2 });
    await benchmark.resolveSource(null, signal());
    expect(hub.authorizations.length).toBeGreaterThan(0);
    expect(hub.authorizations.every(value => value === "Bearer node-dataset-token")).toBe(true);
  } finally { await registry.dispose(); }
});

test.each(["parsed-json", "pdf"] as const)("%s prepares all documents with stable uid and private answer hints", async format => {
  const cacheDir = await root(); const fixture = await officeQAFiles(join(cacheDir, "source"), format);
  const config = parseOfficeQAProV2Config({ cacheDir, corpusFormat: format });
  const benchmark = new OfficeQAProV2Benchmark(config, fixture.source, { questions: 2, documents: 2 });
  const lock = await benchmark.resolveSource(null, signal());
  const refs = []; for await (const ref of benchmark.enumerate(lock, signal())) refs.push(ref);
  expect(refs).toEqual([{ id: "qid_7", recordKey: "qid_7" }, { id: "qid_9", recordKey: "qid_9" }]);
  const task = await benchmark.prepare(refs[0]!, lock, signal());
  expect(JSON.parse(JSON.stringify(task))).toEqual(task);
  expect(task.verification).toMatchObject({ answer: "21.58", source_docs: "private-page-999", source_files: "private-reference.txt" });
  expect(JSON.stringify(task.input)).not.toContain("private-");
  expect(JSON.stringify(task.input)).not.toContain("21.58");
  const build = task.solveEnv.build!;
  const { buildFileManifest } = await import("../../src/core/artifacts/artifacts.js");
  const manifest = await buildFileManifest(build.context, []);
  expect(manifest.files.map(file => file.path).sort()).toEqual(["Dockerfile", `corpus/public-a.${format === "pdf" ? "pdf" : "json"}`, `corpus/public-b.${format === "pdf" ? "pdf" : "json"}`].sort());
  expect(await readFile(join(build.context, "Dockerfile"), "utf8")).not.toMatch(/reward|csv|TOKEN|private-/);
  expect(benchmark.discloseAnswer(task)).toBe("21.58");
  expect((await benchmark.planRun([refs[0]!], lock, signal())).preparation.defaultTimeoutSeconds).toBe(3600);
  await expect(benchmark.prepare({ id: "qid_7", recordKey: "qid_9" }, lock, signal())).rejects.toThrow();
  const node = new OfficeQAProV2Benchmark({ ...config, cacheDir: await root() }, fixture.source, { questions: 2, documents: 2 });
  expect(await node.resolveSource(JSON.parse(JSON.stringify(lock)), signal())).toEqual(lock);
  const rematerialized = await node.prepare(refs[0]!, lock, signal());
  expect(rematerialized.solveEnv.build?.context).not.toBe(build.context);
  expect(rematerialized.solveEnv.build?.sourceHash).toBe(build.sourceHash);
  await writeFile(join(build.context, "corpus", `public-a.${format === "pdf" ? "pdf" : "json"}`), "corrupt");
  const resumed = new OfficeQAProV2Benchmark(config, fixture.source, { questions: 2, documents: 2 });
  await expect(resumed.prepare(refs[0]!, lock, signal())).rejects.toThrow(/differs/);
  await expect(benchmark.resolveSource(null, AbortSignal.abort())).rejects.toThrow();
});

test.each([fixtureCSV.replace("qid_9", "qid_7"), fixtureCSV.replace("21.58", ""), fixtureCSV.replace("uid,question", "bad,question")])("reject invalid question data", async csv => {
  const cacheDir = await root(); const fixture = await officeQAFiles(join(cacheDir, "source"), "parsed-json", csv);
  const benchmark = new OfficeQAProV2Benchmark(parseOfficeQAProV2Config({ cacheDir }), fixture.source, { questions: 2, documents: 2 });
  const lock = await benchmark.resolveSource(null, signal());
  await expect(benchmark.prepare({ id: "qid_7", recordKey: "qid_7" }, lock, signal())).rejects.toThrow();
});

test.each(["parsed-json", "pdf"] as const)("HF snapshot %s locks bytes, restores corrupt cache and resumes offline", async format => {
  const cacheDir = await root(); const fixture = await officeQAFiles(join(cacheDir, "source"), format);
  const hub = await officeQAHub(fixture.bytes); hubs.push(hub);
  const definition = { dataset: "databricks/officeqa-pro-v2", revision: OFFICEQA_DATASET_REVISION,
    selections: [{ path: "officeqa_pro_v2.csv" }, { prefix: format === "pdf" ? "pdfs/" : "parsed_corpus/jsons/", suffix: format === "pdf" ? ".pdf" : ".json" }] };
  const source = new HuggingFaceSnapshotSource(cacheDir, definition, "fixture-secret", hub.transport);
  const lock = await source.resolve(null, signal());
  expect(lock.files).toHaveLength(3);
  expect(hub.requests.filter(path => path.includes("/resolve/"))).toHaveLength(1);
  expect(hub.requests.at(-1)).toContain("officeqa_pro_v2.csv");
  for (const file of lock.files) await source.file(lock, file.path, signal());
  expect(JSON.stringify(lock)).not.toContain("fixture-secret");
  const savedRequests = hub.requests.length;
  hub.deny(403);
  expect(await source.resolve(JSON.parse(JSON.stringify(lock)), signal())).toEqual(lock);
  expect(hub.requests).toHaveLength(savedRequests);
  const path = await source.file(lock, "officeqa_pro_v2.csv", signal());
  await writeFile(path, "corrupt"); hub.deny(200);
  expect(await readFile(await source.file(lock, "officeqa_pro_v2.csv", signal()), "utf8")).toBe(fixtureCSV);
  await writeFile(path, "corrupt again"); fixture.bytes.set("officeqa_pro_v2.csv", Buffer.from("changed upstream bytes"));
  await expect(source.file(lock, "officeqa_pro_v2.csv", signal())).rejects.toThrow();
  fixture.bytes.set("officeqa_pro_v2.csv", Buffer.from(fixtureCSV));
  await source.file(lock, "officeqa_pro_v2.csv", signal());
  const altered = structuredClone(lock); altered.revision = "a".repeat(40);
  await expect(source.resolve(altered, signal())).rejects.toThrow(/snapshot/);
  await expect(source.file(lock, "missing", signal())).rejects.toThrow(/absent/);
  await expect(source.resolve(null, AbortSignal.abort())).rejects.toThrow();
  const missing = new HuggingFaceSnapshotSource(cacheDir, { ...definition, selections: [{ path: "missing" }] }, undefined, hub.transport);
  await expect(missing.resolve(null, signal())).rejects.toThrow(/Missing/);
  for (const status of [401, 403]) { hub.deny(status); await expect(source.resolve(null, signal())).rejects.toThrow(/access denied/); }
});

test("OfficeQA is discoverable without network and Ray localizes node paths", async () => {
  const directory = await root(); const file = join(directory, "experiment.yaml");
  vi.stubEnv("OFFICEQA_TEST_KEY", "fixture");
  await writeFile(file, "services:\n  default:\n    model: fixture\n    base_url: https://fixture.invalid\n    api_key: ${OFFICEQA_TEST_KEY}\nbenchmark: officeqa-pro-v2\n");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const output: string[] = []; const errors: string[] = [];
  const io = { out: (value: string) => { output.push(value); }, error: (value: string) => { errors.push(value); } };
  for (const args of [["benchmark", "list"], ["benchmark", "info", "officeqa-pro-v2"], ["init", "--benchmark", "officeqa-pro-v2", "--output", join(directory, "init.yaml")]])
    expect(await runCli(args, io), errors.join("\n")).toBe(0);
  expect(output.join("\n")).toContain("officeqa-pro-v2");
  const config = await loadConfig(file, {}, process.env); expect(config.experiment.run.timeoutSeconds).toBe(3600);
  const fixture = await officeQAFiles(join(directory, "source"), "parsed-json", "uid,question,answer,source_docs,source_files\n" +
    Array.from({ length: 90 }, (_, i) => `qid_${i},Question ${i},42,private-page,private-file\n`).join(""));
  const csv = fixture.lock.files[0]!; const doc = fixture.lock.files[1]!;
  const lock = { ...fixture.lock, files: [csv, ...Array.from({ length: 1435 }, (_, i) => ({ ...doc, path: `parsed_corpus/jsons/document-${i}.json` }))] };
  vi.spyOn(HuggingFaceSnapshotSource.prototype, "resolve").mockResolvedValue(lock);
  const files = vi.spyOn(HuggingFaceSnapshotSource.prototype, "file").mockImplementation(async (_lock, path) => {
    if (path !== "officeqa_pro_v2.csv") throw new Error("dry-run attempted corpus download");
    return fixture.paths.get(path)!;
  });
  expect(await runCli(["run", file, "--dry-run"], io), errors.join("\n")).toBe(0);
  expect(files).toHaveBeenCalledOnce();
  const bad = structuredClone(config); bad.experiment.environment = { name: "local", config: {} };
  await expect(bootstrapBenchmark(bad, directory)).rejects.toThrow(/Docker/);
  expect(network).not.toHaveBeenCalled();
  const registry = await openPluginRegistry();
  try {
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    const selection = { name: "officeqa-pro-v2", config: { cacheDir: "/coordinator/cache", dockerExecutable: "/coordinator/docker", corpusFormat: "pdf", hfToken: "coordinator-secret" } };
    // Node-local fields are removed by projection before validation.
    const { projectPortableSelection } = await import("../../src/infrastructure/ray/protocol.js");
    const portable = projectPortableSelection(selection, "benchmark", lookup);
    validatePortableSelection(portable, "benchmark", lookup);
    expect(JSON.stringify(portable)).not.toContain("coordinator");
    expect(portable.config).not.toHaveProperty("hfToken");
    expect(() => validatePortableSelection({ ...portable, config: { ...portable.config, hfToken: "injected-secret" } }, "benchmark", lookup)).toThrow(/Credentials/);
    expect(localizePortableSelection(portable, "benchmark", { outputRoot: "/node", dockerExecutable: "/node/docker" }, lookup).config).toMatchObject({ cacheDir: join("/node", "cache", "benchmark", "officeqa-pro-v2"), dockerExecutable: "/node/docker", corpusFormat: "pdf" });
  } finally { await registry.dispose(); }
});

const python = ["python3", "python"].find(executable => spawnSync(executable, ["--version"], { windowsHide: true }).status === 0);
test.skipIf(!python)("unchanged upstream Python scorer covers OfficeQA answer formats", async () => {
  const cases = [
    ["21.58", "<FINAL_ANSWER>21.58</FINAL_ANSWER>", 0, 1], ["21.58", "21.59", 0, 0],
    ["100", "101", 0.01, 1], ["100", "101.1", 0.01, 0], ["$7,046,001.98", "$7,046,001.98", 0, 1],
    ["-1234", "(1,234)", 0, 1], ["5%", "5%", 0, 1], ["543 million", "543 billion", 0, 0],
    ["[Massachusetts, 0.866]", "Massachusetts, with a ratio of 0.866", 0, 1],
    ["[1, 2]", "[2, 1]", 0, 0], ["[1, 2]", "[1, 2]", 0, 1], ["21.58", "", 0, 0],
    ["21.58", "<FINAL_ANSWER>0</FINAL_ANSWER><FINAL_ANSWER>21.58</FINAL_ANSWER>", 0, 1],
  ] as const;
  const program = await officeQAScoringProgram();
  for (const [answer, prediction, tolerance, score] of cases) {
    const result = spawnSync(python!, ["-c", program], { input: JSON.stringify({ answer, prediction, tolerance }), encoding: "utf8", windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout), `${answer} / ${prediction}`).toEqual({ score });
  }
});
