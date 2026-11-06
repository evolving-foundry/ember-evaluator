vi.mock("../../src/application/diagnostics/network.js", () => ({ diagnoseNetwork: async () => [] }));
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../../src/application/config.js";
import { bootstrapBenchmark } from "../../src/application/plugins/bootstrap.js";
import { runCli } from "../../src/cli/main.js";
import { assertSourceLock } from "../../src/index.js";

const examples = fileURLToPath(new URL("../fixtures/benchmark-examples/", import.meta.url));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), "benchmark-examples-")); roots.push(root);
  await cp(join(examples, "questions.json"), join(root, "questions.json"));
  await cp(join(examples, "harbor"), join(root, "harbor"), { recursive: true });
  const patchPath = join(root, "patch.yaml"), file = join(root, "experiment.yaml");
  await writeFile(patchPath, stringify([{ insert: [
    ...["definition", "protocol", "harbor-profile"].map(id => ({ id, name: join(examples, `${id}.mjs`) })),
    { id: "controlled-solver", name: join(dirname(examples), "cli/plugin.mjs") },
  ] }]));
  await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${KEY}" } },
    benchmark: { name, solver: "cli-fixture" }, run: { maxTasks: 2 }, output: { directory: "./results" } }));
  return { root, patchPath, file };
}

test.each(["example-definition", "example-protocol", "example-harbor"])("%s has locked, serializable tasks with private verification", async name => {
  const f = await fixture(name);
  const config = await loadConfig(f.file, {}, { KEY: "fixture-key" }, { patchPath: f.patchPath });
  const components = await bootstrapBenchmark(config, f.root, f.patchPath);
  try {
    const benchmark = components.benchmark;
    const signal = AbortSignal.timeout(5000);
    const source = await benchmark.resolveSource(null, signal);
    assertSourceLock(source);
    expect(await benchmark.resolveSource(JSON.parse(JSON.stringify(source)), signal)).toEqual(source);
    const refs = [];
    for await (const ref of benchmark.enumerate(source, signal)) refs.push(ref);
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map(ref => ref.id)).size).toBe(2);
    for (const ref of refs) {
      const task = await benchmark.prepare(ref, source, signal);
      expect(JSON.parse(JSON.stringify(task))).toEqual(task);
      expect(JSON.stringify(task.input)).not.toContain("42");
      expect(JSON.stringify(task.solveEnv)).not.toContain("test.sh");
      if (name !== "example-harbor") {
        expect(await benchmark.verify(task, { finalText: "42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } }, null, signal)).toMatchObject({ score: 1, passed: true });
        await expect(benchmark.verify(task, { finalText: "42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } }, null,
          AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
      }
    }
    await expect(benchmark.resolveSource(null, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow();
    const changed = name === "example-harbor" ? join(f.root, "harbor/tasks/multiply/instruction.md") : join(f.root, "questions.json");
    await writeFile(changed, (await readFile(changed, "utf8")).replace("6", "8"));
    await expect(benchmark.resolveSource(source, signal)).rejects.toThrow(/changed|differs/i);
  } finally { await components.dispose(); await components.dispose(); }
});

test.each(["example-definition", "example-protocol"])("%s supports discovery, doctor, run, report and resume with an external patch", async name => {
  vi.stubEnv("KEY", "fixture-key");
  const f = await fixture(name);
  const out: string[] = [], errors: string[] = [];
  const io = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
  for (const args of [["benchmark", "list", "--json"], ["benchmark", "info", name], ["inspect", f.file], ["doctor", f.file], ["run", f.file]]) {
    const credential = args[0] !== "run" ? [] : ["--api-key", "fixture-key"];
    expect(await runCli([...args, "--patch", f.patchPath, ...credential], io), errors.join("\n")).toBe(0);
  }
  const run = out.at(-1);
  if (!run) throw new Error("No result directory");
  expect(await runCli(["report", run], io), errors.join("\n")).toBe(0);
  expect(await readFile(join(run, "report.md"), "utf8")).toContain('| 正确率 | 100.00% |');
  expect(await runCli(["run", f.file, "--patch", f.patchPath, "--api-key", "fixture-key", "--resume"], io)).toBe(0);
  expect((await readFile(join(run, "manifest.json"), "utf8"))).not.toContain("fixture-key");
}, 30_000);
