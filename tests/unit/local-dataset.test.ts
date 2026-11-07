import { cp, mkdir, mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LocalFileSource, LocalRecordSource } from "../../src/infrastructure/datasets/sources/local/files-source.js";
import { LocalZipJsonSource } from "../../src/infrastructure/datasets/sources/local/zip-json-source.js";
import { DEFINED_BENCHMARKS } from "../../src/plugins/benchmarks/agent-harness/definitions/index.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { createBenchmark } from "../../src/application/plugins/create-components.js";
import { loadConfig } from "../../src/application/config.js";
import { stringify } from "yaml";
import { projectPortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/index.js";
import { AgentXBenchmark, parseAgentXConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/agentx-benchmark.js";
import { parseWorkload } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { officeQAFiles } from "../fixtures/officeqa.js";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> { const rows: T[] = []; for await (const row of values) rows.push(row); return rows; }
const roots: string[] = [];
const signal = () => AbortSignal.timeout(10000);
async function root() { const path = await mkdtemp(join(tmpdir(), "local-dataset-")); roots.push(path); return path; }
async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test.each(DEFINED_BENCHMARKS)("$definition.name uses a YAML-relative local dataset with no Hub requests", async ({ definition, source }) => {
  const path = await root();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
  for (const selection of source.selections) await put(path, `dataset/${selection.path ?? `${selection.prefix}000.${selection.format}`}`, "fixture content");
  const file = join(path, "experiment.yaml");
  await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://model.invalid/v1", api_key: "${TEST_KEY}" }, judge: { model: "fixture", base_url: "https://model.invalid/v1", api_key: "${TEST_KEY}" } },
    benchmark: { name: definition.name, config: { localPath: "./dataset" } } }));
  const config = await loadConfig(file, {}, { TEST_KEY: "fixture" });
  const registry = await openPluginRegistry();
  try {
    const benchmark = await createBenchmark(registry, config, path);
    const lock = await benchmark.resolveSource(null, signal());
    expect(lock.source).toBe(`local:${source.dataset}`);
    expect(lock.files).toHaveLength(source.selections.length);
    expect(await benchmark.resolveSource(lock, signal())).toEqual(lock);
    expect(fetch).not.toHaveBeenCalled();
    await put(path, `dataset/${source.selections[0]!.path ?? `${source.selections[0]!.prefix}000.${source.selections[0]!.format}`}`, "changed");
    await expect(benchmark.resolveSource(lock, signal())).rejects.toThrow(/changed/);
  } finally { await registry.dispose(); }
}, 30000);

test.each([
  { name: "workbuddy", scenario: "code", path: "./data", tasksRoot: "tasks" },
  { name: "workbuddy", scenario: "office", path: "./data", tasksRoot: "tasks" },
  { name: "terminalbench", version: "4.0", path: "./data/tasks", tasksRoot: "." },
])("$name $scenario $version reads local tasks while preserving its profile", async ({ path: localPath, tasksRoot, ...selection }) => {
  const directory = await root();
  await cp(fileURLToPath(new URL("../fixtures/benchmark-examples/harbor/", import.meta.url)), join(directory, "data"), { recursive: true });
  const file = join(directory, "experiment.yaml");
  await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://model.invalid/v1", api_key: "${TEST_KEY}" } },
    benchmark: { ...selection, config: { source: { kind: "local", path: localPath }, tasks: { expectedCount: 2 } } } }));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
  const config = await loadConfig(file, {}, { TEST_KEY: "fixture" });
  expect(config.experiment.benchmark.config.source).toEqual({ kind: "local", path: localPath });
  expect(config.experiment.benchmark.config.tasks).toMatchObject({ root: tasksRoot, expectedCount: 2 });
  const registry = await openPluginRegistry();
  try {
    const benchmark = await createBenchmark(registry, config, directory);
    const lock = await benchmark.resolveSource(null, signal());
    expect(await collect(benchmark.enumerate(lock, signal()))).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  } finally { await registry.dispose(); }
});

test.each([
  { format: "jsonl" as const, path: "test.jsonl", content: '{"question":"hello","answer":"42"}\n' },
  { format: "csv" as const, path: "test.csv", content: 'question,answer\nhello,42\n' },
])("local $format rows preserve values and reject changes between lock and read", async ({ format, path, content }) => {
  const directory = await root(); await put(directory, path, content);
  const source = new LocalRecordSource(directory, { dataset: "test", revision: "main", selections: [{ key: "test", path, format }] });
  const lock = await source.resolve(null, signal());
  expect(await collect(source.rows(lock, "test", signal()))).toEqual([{ question: "hello", answer: "42" }]);
  const single = new LocalRecordSource(join(directory, path), { dataset: "test", revision: "main", selections: [{ key: "test", path, format }] });
  expect(await collect(single.rows(await single.resolve(null, signal()), "test", signal()))).toEqual([{ question: "hello", answer: "42" }]);
  await put(directory, path, content + "changed");
  await expect(collect(source.rows(lock, "test", signal()))).rejects.toThrow(/changed/);
});

test("local snapshots reject missing selections, forged locks, symlinks and cancellation", async () => {
  const path = await root();
  const source = new LocalFileSource(path, { dataset: "test", selections: [{ path: "data.jsonl" }, { path: "dev.jsonl" }] });
  await put(path, "data.jsonl", "{}");
  await expect(source.resolve(null, signal())).rejects.toThrow("dev.jsonl");
  await put(path, "dev.jsonl", "{}");
  const lock = await source.resolve(null, signal());
  await expect(source.file({ ...lock, revision: "forged" }, "data.jsonl", signal())).rejects.toThrow(/lock/);
  await expect(source.file(lock, "../data.jsonl", signal())).rejects.toThrow();
  await expect(source.resolve(null, AbortSignal.abort())).rejects.toThrow();
  // Junction creation is available on Windows without symlink privileges.
  const link = join(path, "linked"); await symlink(path, link, "junction");
  await expect(new LocalFileSource(link, { dataset: "test", selections: [{ path: "data.jsonl" }] }).resolve(null, signal())).rejects.toThrow(/symlink/);
});

test.each(["directory", "file"])("local %s input rejects Git LFS placeholders without downloading", async mode => {
  const path = await root();
  await put(path, "corpus.pdf", `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
  const source = new LocalFileSource(mode === "file" ? join(path, "corpus.pdf") : path,
    { dataset: "test", selections: [{ path: "corpus.pdf" }] });
  await expect(source.resolve(null, signal())).rejects.toThrow(/Git LFS pointer: corpus\.pdf/);
  expect(fetch).not.toHaveBeenCalled();
});

test("AgentX prepares a local trace without downloading and carries a content revision", async () => {
  const path = await root(); await put(path, "traces.jsonl", '{"trace":"fixture"}\n');
  const benchmark = new AgentXBenchmark(parseAgentXConfig({ localPath: path, cacheDir: join(path, "cache") }), "local");
  const lock = await benchmark.resolveSource(null, signal());
  const ref = (await collect(benchmark.enumerate(lock, signal())))[0]!;
  const task = await benchmark.prepare(ref, lock, signal());
  expect(task.solveEnv.initialFiles[0]?.source).toBe(join(path, "traces.jsonl"));
  expect(parseWorkload(task.input.payload).revision).toMatch(/^local:[a-f0-9]{64}$/);
});

test.each(["pdf", "parsed-json"] as const)("OfficeQA reads local questions and the complete %s corpus", async format => {
  const path = await root();
  const fixture = await officeQAFiles(join(path, "fixture"), format);
  for (const [name, content] of fixture.bytes) await put(path, `dataset/${name}`, content);
  const benchmark = new OfficeQAProV2Benchmark(parseOfficeQAProV2Config({ localPath: join(path, "dataset"), cacheDir: join(path, "cache"), corpusFormat: format }), undefined,
    { questions: 2, documents: 2 });
  const lock = await benchmark.resolveSource(null, signal());
  expect(await collect(benchmark.enumerate(lock, signal()))).toHaveLength(2);
  const ref = (await collect(benchmark.enumerate(lock, signal())))[0]!;
  const task = await benchmark.prepare(ref, lock, signal());
  expect(task.input.prompt).toContain("What is the receipt?");
  expect(task.solveEnv.build).toBeDefined();
});

test("DROP reads extracted local JSON selections", async () => {
  const path = await root(); const selections = { train: "drop_dataset/train.json", test: "drop_dataset/dev.json" };
  for (const name of Object.values(selections)) await put(path, name, '{"passage":{"qa_pairs":[]}}');
  const source = new LocalZipJsonSource(path, selections);
  expect(await collect(source.rows(await source.resolve(null, signal()), "test", signal()))).toEqual([{ passage: { qa_pairs: [] } }]);
});

test("Ray rejects local dataset paths before dispatch for every new local-data component", async () => {
  const registry = await openPluginRegistry();
  try {
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    for (const name of [...DEFINED_BENCHMARKS.map(entry => entry.definition.name), "drop", "officeqa-pro-v2", "agentx"])
      expect(() => projectPortableSelection({ name, config: { localPath: "/private/data" } }, "benchmark", lookup)).toThrow(/localPath/);
  } finally { await registry.dispose(); }
});
