import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, expect, test, vi } from "vitest";
import { DatasetCache } from "../../src/infrastructure/datasets/cache.js";
import { withDatasetActivity } from "../../src/infrastructure/datasets/activity.js";
import { extractHttpArchive } from "../../src/infrastructure/datasets/sources/http/archive.js";
import { HarborBenchmark } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/harbor-benchmark.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { planBenchmarkRun } from "../../src/plugins/benchmarks/shared/plan-run.js";
import { progressOperation } from "../../src/core/progress/progress-operation.js";
import { enumerateSelectedTasks } from "../../src/core/selection/task-selection.js";
import { runEngine } from "../../src/application/run-engine.js";
import type { ComponentActivity } from "../../src/core/contracts/activity.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { harness, source } from "../fixtures/engine/fakes.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "dataset-live-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const listener = createServer(handler);
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    listener.closeAllConnections();
    listener.close(error => error ? reject(error) : resolve());
  }));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}
const lines = (events: ComponentActivity[]) => events.flatMap(event => event.lines ?? []).join("\n");

test("download bytes arrive before completion, concurrent waiters see the current snapshot, and cache hits do not download", async () => {
  const cache = new DatasetCache(await root());
  const gate = Promise.withResolvers<void>();
  cleanup.push(async () => gate.resolve());
  const received = Promise.withResolvers<void>();
  const one: ComponentActivity[] = [];
  const two: ComponentActivity[] = [];
  let requests = 0;
  const origin = await server((_request, response) => {
    requests++;
    response.writeHead(200, { "content-length": "4096" });
    response.write(Buffer.alloc(2048, "a"));
    void gate.promise.then(() => response.end(Buffer.alloc(2048, "b")));
  });
  const signal = new AbortController().signal;
  const url = `${origin}/private-tests/secret-file?token=fixture-secret`;
  let complete = false;
  const pending = withDatasetActivity(event => {
    one.push(event);
    if (lines([event]).includes("50%")) received.resolve();
  }, () => cache.fetch(url, null, signal)).then(value => { complete = true; return value; });
  await received.promise;
  expect(complete).toBe(false);
  const joined = withDatasetActivity(event => two.push(event), () => cache.fetch(url, null, signal));
  expect(lines(two)).toContain("2.0 KiB / 4.0 KiB (50%)");
  expect(two[0]?.activity).toBe(false);
  gate.resolve();
  const [result, second] = await Promise.all([pending, joined]);
  expect(result).toEqual(second);
  expect(lines(one)).toContain("4.0 KiB / 4.0 KiB (100%)");
  expect(lines(two)).toContain("Data cached");
  expect(lines(one)).not.toMatch(/fixture-secret|secret-file|private-tests|token=/u);
  const hits: ComponentActivity[] = [];
  await withDatasetActivity(event => hits.push(event), () => cache.fetch(url, result.sha256, signal));
  expect(lines(hits)).toContain("Data cache hit");
  expect(requests).toBe(1);
  expect((await readFile(result.path)).length).toBe(4096);
});

test("compressed and unknown-length responses report decoded bytes without a false total or percentage", async () => {
  const cache = new DatasetCache(await root());
  const content = Buffer.alloc(8192, "x");
  const compressed = gzipSync(content);
  const origin = await server((request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-length": compressed.length, "content-encoding": "gzip" });
      response.end(compressed);
    } else {
      response.writeHead(200);
      response.write(content.subarray(0, 4096)); response.end(content.subarray(4096));
    }
  });
  for (const path of ["/gzip", "/chunked"]) {
    const events: ComponentActivity[] = [];
    await withDatasetActivity(event => events.push(event), () => cache.fetch(origin + path, null, new AbortController().signal));
    expect(lines(events)).toContain("8.0 KiB");
    expect(lines(events)).not.toContain("%");
    expect(lines(events)).not.toContain(" / ");
  }
});

test("independent concurrent source scopes do not exchange their byte previews", async () => {
  const cache = new DatasetCache(await root());
  const origin = await server((request, response) => response.end(Buffer.alloc(request.url === "/one" ? 1024 : 3072)));
  const one: ComponentActivity[] = []; const two: ComponentActivity[] = [];
  const signal = new AbortController().signal;
  await Promise.all([
    withDatasetActivity(event => one.push(event), () => cache.fetch(origin + "/one", null, signal)),
    withDatasetActivity(event => two.push(event), () => cache.fetch(origin + "/two", null, signal)),
  ]);
  expect(lines(one)).toContain("1.0 KiB"); expect(lines(one)).not.toContain("3.0 KiB");
  expect(lines(two)).toContain("3.0 KiB"); expect(lines(two)).not.toContain("1.0 KiB");
});

test("a cancelled download closes its live operation and does not leave temporary bytes", async () => {
  const directory = await root(); const cache = new DatasetCache(directory);
  const origin = await server((_request, response) => { response.writeHead(200); response.write("first bytes"); });
  const controller = new AbortController();
  const events: ProgressEvent[] = [];
  const received = Promise.withResolvers<void>();
  const pending = progressOperation(event => {
    events.push(event);
    if (event.live?.lines.some(line => line.includes("Downloading 127"))) received.resolve();
  }, { phase: "source", message: "准备数据集" }, controller.signal,
  activity => withDatasetActivity(activity, () => cache.fetch(origin, null, controller.signal)));
  const rejected = expect(pending).rejects.toBeDefined();
  await received.promise;
  controller.abort(new Error("user cancelled"));
  await rejected;
  expect(events.at(-1)?.live?.status).toBe("cancelled");
  const { readdir } = await import("node:fs/promises");
  expect((await readdir(directory)).some(name => name.startsWith(".download-"))).toBe(false);
});

test("archive validation and extraction expose counts without file names or contents", async () => {
  const directory = await root();
  await writeFile(join(directory, "hidden-answer.txt"), "private-answer");
  const archive = join(directory, "fixture.tar.gz");
  await tar.c({ file: archive, cwd: directory, gzip: true }, ["hidden-answer.txt"]);
  const bytes = await readFile(archive);
  const origin = await server((_request, response) => response.end(bytes));
  const stage = join(directory, "stage"); await mkdir(stage);
  const events: ComponentActivity[] = [];
  await withDatasetActivity(event => events.push(event), () => extractHttpArchive({ kind: "archive", url: origin,
    sha256: createHash("sha256").update(bytes).digest("hex"), root: "." }, join(directory, "cache"), stage, new AbortController().signal));
  expect(lines(events)).toContain("Checked 1 archive entries");
  expect(lines(events)).toContain("Extraction completed 1/1");
  expect(lines(events)).not.toMatch(/hidden-answer|private-answer/u);
  expect(await readFile(join(stage, "hidden-answer.txt"), "utf8")).toBe("private-answer");
});

test("planning reports each task before preparation ends, retains failures, and preserves the stage clock", async () => {
  const fixture = harness(await root());
  cleanup.push(() => fixture.components.dispose());
  const gate = Promise.withResolvers<void>(); cleanup.push(async () => gate.resolve());
  const started = Promise.withResolvers<void>();
  const prepare = fixture.components.benchmark.prepare.bind(fixture.components.benchmark);
  fixture.components.benchmark.prepare = async (ref, lock, signal, activity) => {
    if (ref.id === "b") { activity?.({ lines: ["准备任务文件 2/8"] }); started.resolve(); await gate.promise; }
    if (ref.id === "c") throw Object.assign(new Error("unsupported task"), { code: "BENCHMARK_UNSUPPORTED" });
    return prepare(ref, lock, signal);
  };
  const events: ProgressEvent[] = [];
  const signal = new AbortController().signal;
  const pending = progressOperation(event => events.push(event), { phase: "prepare", message: "规划整批环境" }, signal,
    activity => planBenchmarkRun(fixture.components.benchmark, ["a", "b", "c"].map(id => ({ id, recordKey: id })), source, signal,
      { version: "fixture", source: "fixture" }, 600, activity));
  await started.promise;
  expect(events.at(-1)?.message).toBe("Planning task 2/3 b");
  expect(events.at(-1)?.live?.lines).toContain("准备任务文件 2/8");
  expect(events.filter(event => event.live?.status === "started")).toHaveLength(1);
  gate.resolve();
  const result = await pending;
  expect(result.tasks).toHaveLength(2); expect(result.preparationFailures).toHaveLength(1);
  expect(events.at(-1)?.live?.lines).toContain("Planning completed 3/3; 2 succeeded, 1 failed");
  expect(events.at(-1)?.live?.status).toBe("completed");
  const elapsed = events.flatMap(event => event.live ? [event.live.elapsedMs] : []);
  expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
});

test("engine forwards source and enumeration observations without persisting temporary events", async () => {
  const fixture = harness(await root()); cleanup.push(() => fixture.components.dispose());
  fixture.components.benchmark.resolveSource = async (_previous, _signal, activity) => {
    activity?.({ lines: ["来源文件 3/7"] }); return source;
  };
  const events: ProgressEvent[] = [];
  const result = await runEngine({ components: fixture.components, config: fixture.config, signal: new AbortController().signal,
    onProgress: event => events.push(event) });
  expect(events.some(event => event.phase === "source" && event.live?.lines.includes("来源文件 3/7"))).toBe(true);
  expect(events.some(event => event.phase === "enumerate" && event.live?.lines.includes("Enumeration completed: 3 tasks available, 3 selected"))).toBe(true);
  expect(JSON.stringify(result)).not.toContain("来源文件 3/7");
  expect(JSON.stringify(result)).not.toContain("Enumeration completed");
  // Existing plugins which omit the optional activity arguments still enumerate normally.
  const selection = await enumerateSelectedTasks(fixture.components.benchmark, source, fixture.config.experiment.run, new AbortController().signal);
  expect(selection.selected).toHaveLength(3);
});

test("real Harbor local source and batch planning forward directory, checksum and task counts", async () => {
  const directory = await root();
  await writeFixture(directory, {
    "tasks/example/task.toml": '[task]\nname = "fixture/example"\n',
    "tasks/example/instruction.md": "Public task",
    "tasks/example/environment/Dockerfile": "FROM fixture:locked\nWORKDIR /app\n",
    "tasks/example/tests/test.sh": "private-check-body",
  });
  const benchmark = new HarborBenchmark(parseHarborConfig({ dataset: "fixture@1", source: { kind: "local", path: directory }, tasks: { expectedCount: 1 } }));
  const events: ComponentActivity[] = [];
  const activity = (event: ComponentActivity) => events.push(event);
  const signal = new AbortController().signal;
  const lock = await benchmark.resolveSource(null, signal, activity);
  expect(lines(events)).toContain("Source digests completed: 4 files");
  expect(lines(events)).toContain("Scanning task directory 1/1");
  const { selected } = await enumerateSelectedTasks(benchmark, lock, { maxTasks: null, taskIds: null }, signal, activity);
  const plan = await benchmark.planRun(selected, lock, signal, activity);
  expect(plan.tasks).toHaveLength(1);
  expect(events.some(event => event.message === "Planning task 1/1 fixture/example")).toBe(true);
  expect(lines(events)).toContain("Planning completed 1/1");
  expect(lines(events)).not.toMatch(/private-check-body|tests\/test.sh/u);
});

test("fatal planning errors end the operation as failed without claiming all tasks were checked", async () => {
  const fixture = harness(await root()); cleanup.push(() => fixture.components.dispose());
  fixture.components.benchmark.prepare = async () => { throw new Error("source changed"); };
  const events: ProgressEvent[] = [];
  const signal = new AbortController().signal;
  await expect(progressOperation(event => events.push(event), { phase: "prepare", message: "规划" }, signal,
    activity => planBenchmarkRun(fixture.components.benchmark, [{ id: "a", recordKey: "a" }], source, signal,
      { version: "fixture", source: "fixture" }, 600, activity))).rejects.toThrow("source changed");
  expect(events.at(-1)?.live?.status).toBe("failed");
  expect(events.at(-1)?.live?.lines.join("\n")).not.toContain("Checked");
});
