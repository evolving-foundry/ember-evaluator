import "../fixtures/network-fetch.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { DEFINED_BENCHMARKS } from "../../src/plugins/benchmarks/agent-harness/definitions/index.js";
import { openPluginRegistry } from "../../src/application/plugins/runtime.js";
import { loadConfig, loadSavedConfig } from "../../src/application/config.js";
import { exportConfig } from "../../src/config/export.js";
import { bootstrapBenchmark } from "../../src/application/plugins/bootstrap.js";
import { localizePortableSelection, projectPortableSelection, validatePortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { parseAgentXConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/agentx-benchmark.js";
import { parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "hf-auth-config-")); roots.push(path); return path; }

test.each(DEFINED_BENCHMARKS.map(entry => ({ name: entry.definition.name, source: entry.source })))("$name reads explicit HF credentials and omits them from persistence and Ray", async ({ name, source }) => {
  const directory = await root();
  vi.stubEnv("HF_ENDPOINT", "https://fixture-hf.invalid"); vi.stubEnv("HF_TOKEN", "unrelated-process-token");
  const registry = await openPluginRegistry();
  try {
    const settings = ["healthbench", "simpleqa", "math500"].includes(name) ? { judgeService: "judge" } : {};
    for (const bad of [{ hfTokenEnv: "HF_TOKEN" }, { hfToken: "" }, { hfToken: 123 }])
      expect(() => registry.ctx.evaluator.prepare("benchmark", { name, config: { ...settings, ...bad } })).toThrow();
    const model = { model: "fixture", base_url: "https://model.invalid", api_key: "${MODEL_KEY}" };
    const file = join(directory, "experiment.yaml");
    await writeFile(file, stringify({ services: { default: model, judge: model }, benchmark: { name, config: { ...settings, hfToken: "${DATASET_TOKEN}", cacheDir: join(directory, "cache") } } }));
    const env = { MODEL_KEY: "fixture-model-key", DATASET_TOKEN: "explicit-dataset-token" };
    const config = await loadConfig(file, {}, env, { registry });
    expect(config.experiment.benchmark.config.hfToken).toBe("explicit-dataset-token");
    expect(JSON.stringify(config.persisted)).toContain("${DATASET_TOKEN}");
    expect(JSON.stringify(config.persisted)).not.toContain("explicit-dataset-token");
    expect(JSON.stringify(exportConfig(config))).toContain("${DATASET_TOKEN}");
    const saved = join(directory, "saved.yaml"); await writeFile(saved, stringify(config.persisted));
    const rotated = await loadSavedConfig(saved, { ...env, DATASET_TOKEN: "rotated-dataset-token" }, { registry });
    expect(rotated.persisted).toEqual(config.persisted);
    const paths = source.selections.map(selection => selection.path ?? `${selection.prefix}fixture.${selection.format}`);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer explicit-dataset-token");
      return String(input).includes("/api/datasets/")
        ? new Response(JSON.stringify({ sha: "a".repeat(40), siblings: paths.map(rfilename => ({ rfilename })) }))
        : new Response("fixture file bytes");
    });
    const components = await bootstrapBenchmark(config, directory, undefined, registry);
    await components.benchmark.resolveSource(null, AbortSignal.timeout(5000));
    expect(fetch).toHaveBeenCalledTimes(paths.length + 1);
    const lookup = (role: string, component: string) => registry.ctx.evaluator.configTransport(role, component);
    const portable = projectPortableSelection(config.experiment.benchmark, "benchmark", lookup);
    expect(portable.config).not.toHaveProperty("hfToken");
    expect(JSON.stringify(portable)).not.toContain("explicit-dataset-token");
    expect(() => validatePortableSelection({ ...portable, config: { ...portable.config, hfToken: "injected" } }, "benchmark", lookup)).toThrow(/Credentials/);
    expect(localizePortableSelection(portable, "benchmark", { outputRoot: directory }, lookup).config).not.toHaveProperty("hfTokenEnv");
    expect(() => registry.ctx.evaluator.prepare("benchmark", { name, config: settings })).not.toThrow();
  } finally { await registry.dispose(); }
});

test("AgentX Trace accepts hfToken and rejects hfTokenEnv without adding tokenizer credentials", async () => {
  expect(parseAgentXConfig({ hfToken: "explicit-token" })).toMatchObject({ hfToken: "explicit-token" });
  expect(parseAgentXConfig({})).not.toHaveProperty("hfTokenEnv");
  expect(() => parseAgentXConfig({ hfTokenEnv: "HF_TOKEN" })).toThrow(/unknown field hfTokenEnv/);
  expect(() => parseAgentXConfig({ hfToken: "" })).toThrow(); expect(() => parseAgentXConfig({ hfToken: 123 })).toThrow();
  expect(() => parseAgentXReplayConfig({ hfToken: "not-a-solver-option" })).toThrow(/unknown field hfToken/);
  const registry = await openPluginRegistry();
  try {
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    const portable = projectPortableSelection({ name: "agentx", config: { hfToken: "private-token" } }, "benchmark", lookup);
    expect(portable.config).not.toHaveProperty("hfToken");
    expect(JSON.stringify(portable)).not.toContain("private-token");
  } finally { await registry.dispose(); }
});

test("authenticated Playbooks use env values and existing public examples do not require a token", async () => {
  vi.stubEnv("HF_TOKEN", undefined);
  const env = { MODEL_NAME: "fixture/model", MODEL_ENDPOINT: "https://model.invalid", MODEL_API_KEY: "fixture-model-key", HF_TOKEN: "configured-token", AGENTX_TOKENIZER: "fixture/tokenizer" };
  const config = await loadConfig(resolve("playbook/gpqa/gpqa-simpleagent.yaml"), {}, env);
  expect(config.experiment.benchmark.config.hfToken).toBe("configured-token");
  expect(JSON.stringify(config.persisted)).not.toContain("configured-token");
  const { HF_TOKEN: _token, ...publicEnv } = env;
  for (const file of ["gsm8k/gsm8k-simpleagent.yaml", "mmlu/mmlu-simpleagent.yaml", "humaneval/humaneval-simpleagent.yaml", "agentx/agentx-standard.yaml"])
    expect((await loadConfig(resolve("playbook", file), {}, publicEnv)).experiment.benchmark.config.hfToken).toBeUndefined();
});
