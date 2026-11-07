vi.mock("../../src/application/diagnostics/network.js", () => ({ diagnoseNetwork: async () => [] }));
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { loadConfig } from "../../src/application/config.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { diagnose } from "../../src/application/diagnostics/doctor.js";
import { benchmarkInfo } from "../../src/application/benchmarks.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "onboarding-")); roots.push(root);
  const events = join(root, "events.txt");
  await writeFile(events, "");
  await writeFile(join(root, "plugin.mjs"), `import { appendFileSync } from "node:fs";
export const inject = ["evaluator"];
export function apply(ctx) {
  const event = value => appendFileSync(${JSON.stringify(events)}, value + "\\n");
  ctx.evaluator.registerProfile({ id: "fixture", role: "benchmark", plugin: { name: "fixture", config: {} },
    defaults: { environment: "local", benchmark: { solver: { name: "fixture-solver" } } } });
  ctx.evaluator.register("benchmark", "fixture", v => v, () => ({
    async resolveSource() { event("source"); return { source: "memory", revision: "1", files: [], metadata: null }; },
    async *enumerate() { yield { id: "a", recordKey: "a" }; },
    async prepare() { return { input: { id: "a", prompt: "6 times 7" }, verification: "private-expected",
      solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null }; },
    async verify(task, result) { return { score: result.finalText === "42" ? 1 : 0, passed: result.finalText === "42", details: {} }; }
  }));
  ctx.evaluator.register("solver", "fixture-solver", v => v, () => { event("solver-factory"); return {
    requirements() { return []; }, async solve(input) { if (JSON.stringify(input).includes("private-expected")) throw new Error("private material leaked"); return { finalText: "42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } }; }
  }; });
}`);
  const patch = join(root, "patch.yaml"), file = join(root, "experiment.yaml");
  await writeFile(patch, stringify([{ insert: [{ id: "fixture", name: "./plugin.mjs" }] }]));
  const out: string[] = [], errors: string[] = [];
  const io = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
  vi.stubEnv("MODEL_NAME", "fixture-model"); vi.stubEnv("MODEL_ENDPOINT", "https://fixture.invalid"); vi.stubEnv("MODEL_API_KEY", "never-print-this");
  return { root, patch, file, events, out, errors, io };
}

test("discovery, init, doctor, run and report work through the same explicit patch", async () => {
  const f = await fixture();
  expect(await runCli(["benchmark", "list", "--json", "--patch", f.patch], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "[]")).toContainEqual(expect.objectContaining({ name: "fixture" }));
  expect(await runCli(["benchmark", "info", "fixture", "--patch", f.patch], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "")).toMatchObject({ name: "fixture", implementation: "fixture" });
  expect(await runCli(["init", "--benchmark", "fixture", "--output", f.file, "--patch", f.patch], f.io)).toBe(0);
  const original = await readFile(f.file, "utf8");
  expect(await runCli(["init", "--benchmark", "fixture", "--output", f.file, "--patch", f.patch], f.io)).toBe(2);
  expect(await readFile(f.file, "utf8")).toBe(original);
  expect(await runCli(["doctor", f.file, "--patch", f.patch], f.io)).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "").checks).toContainEqual(expect.objectContaining({ status: "not-checked", name: "model and task execution" }));
  expect(await readFile(f.events, "utf8")).toBe("");
  expect(await runCli(["run", f.file, "--patch", f.patch], f.io)).toBe(0);
  const run = f.out.at(-1);
  if (!run) throw new Error(f.errors.join("\n"));
  expect(await runCli(["report", run], f.io)).toBe(0);
  expect(await readFile(join(run, "report.md"), "utf8")).toContain('| 正确率 | 100.00% |');
  expect(f.out.join("\n") + f.errors.join("\n")).not.toContain("never-print-this");
}, 30_000);

test("init includes an explicit independent judge service from the profile", async () => {
  const f = await fixture();
  expect(await runCli(["init", "--benchmark", "healthbench", "--output", f.file], f.io)).toBe(0);
  const config = parse(await readFile(f.file, "utf8"));
  expect(config.services.judge.api_key).toBe("${JUDGE_API_KEY}");
  vi.stubEnv("JUDGE_NAME", "grader"); vi.stubEnv("JUDGE_ENDPOINT", "https://judge.invalid"); vi.stubEnv("JUDGE_API_KEY", "independent-key");
  const loaded = await loadConfig(f.file, {}, process.env);
  expect(loaded.experiment.benchmark.config.judgeService).toBe("judge");
  expect(loaded.auths.judge?.value).toBe("independent-key");
});

test("Jobs deployment submits without constructing a local solver or resolving sources", async () => {
  const f = await fixture();
  await writeFile(f.file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${MODEL_API_KEY}" } },
    benchmark: "fixture", scheduler: { name: "ray", concurrency: 2 },
    output: { directory: join(f.root, "results") },
    deployment: { kind: "ray-jobs", endpoint: "https://cluster.invalid", caFile: "./ca.pem" } }));
  const call = vi.fn(async (path: string) => { if (path.endsWith("/submit")) throw new Error("submission captured"); return {}; });
  vi.spyOn(JobsClient, "create").mockResolvedValue({ call } as unknown as JobsClient);
  expect(await runCli(["run", f.file, "--patch", f.patch], f.io)).toBe(2);
  expect(f.errors.join("\n")).toContain("submission captured");
  expect(call).toHaveBeenCalledOnce();
  expect(await readFile(f.events, "utf8")).toBe("");
});

test("benchmark info inherits the parent's default scenario", async () => {
  const registry = await openPluginRegistry();
  try {
    registry.ctx.evaluator.registerProfile({ id: "child-agentx", role: "benchmark", extends: "agentx" });
    expect(benchmarkInfo(registry, "child-agentx")).toMatchObject({ defaultScenario: "standard" });
  } finally { await registry.dispose(); }
});

test.skipIf(process.platform === "win32")("doctor applies the same Python versions and PYTHON_BIN selection as AgentX", async () => {
  const f = await fixture();
  const python = join(f.root, "python");
  await writeFile(f.file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${MODEL_API_KEY}" } },
    benchmark: { name: "agentx", scenario: "replay", config: { traceCount: 2 } } }));
  const config = await loadConfig(f.file, {}, process.env);
  await writeFile(python, "#!/bin/sh\nprintf '3.10.12\\n'\n"); await chmod(python, 0o700);
  config.experiment.solver.config.pythonExecutable = python;
  expect(await diagnose(config, f.file, AbortSignal.timeout(5000))).toContainEqual(expect.objectContaining({ name: "AgentX Python", status: "failed" }));
  delete config.experiment.solver.config.pythonExecutable;
  vi.stubEnv("PYTHON_BIN", python);
  await writeFile(python, '#!/bin/sh\nprintf "3.12.8\\n"\nprintf selected > "$0.selected"\n');
  expect(await diagnose(config, f.file, AbortSignal.timeout(5000))).toContainEqual(expect.objectContaining({ name: "AgentX Python", status: "passed" }));
  expect(await readFile(`${python}.selected`, "utf8")).toBe("selected");
  expect(await readFile(f.events, "utf8")).toBe("");
});
