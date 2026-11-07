import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { stringify } from "yaml";
import { exportConfig } from "../../src/config/export.js";
import { loadConfig, loadSavedConfig } from "../../src/application/config.js";
import { resolveConfig, resolveInput } from "../../src/config/resolve.js";
import { parseUserConfig } from "../../src/config/user-schema.js";
import { readProfileDirectory } from "../../src/infrastructure/profiles/read.js";
import { type ConfigProfile } from "../../src/config/profile-schema.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";
import { explainConfig } from "../../src/config/explain.js";
import { assertJsonValue } from "../../src/core/validation/input.js";

const services = { default: { model: "fixture", base_url: "https://model.invalid/v1", api_key: "${TEST_MODEL_KEY}" } };
const profiles = (await Promise.all(["agent-harness", "inference-engine", "operator"].map(category => readProfileDirectory(new URL(`../../src/plugins/benchmarks/${category}/profiles/`, import.meta.url))))).flat();
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function file(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "progressive-config-")); directories.push(dir);
  const path = join(dir, "experiment.yaml"); await writeFile(path, stringify(value)); return path;
}
function user(benchmark: unknown, rest = {}) { return parseUserConfig({ services, benchmark, ...rest }); }
function fingerprint(value: unknown): string { assertJsonValue(value); return fingerprintConfig(value); }

test("Terminal-Bench 4 aliases pin all 66 tasks without changing the 2.0 default", () => {
  const short = resolveConfig("experiment.yaml", user({ name: "terminalbench", version: "4.0" }), profiles);
  const full = resolveConfig("experiment.yaml", user({ name: "terminalbench", version: "4.0.0" }), profiles);
  expect(fingerprint(short)).toBe(fingerprint(full));
  expect(short).toMatchObject({ benchmark: { name: "harbor", config: { dataset: "terminal-bench@4.0.0",
    source: { kind: "archive", url: "https://github.com/harbor-framework/terminal-bench/releases/download/v4.0.0/terminal-bench-prebuilt-v4.0.0.tar.gz",
      sha256: "6d2c57cbcb1a75b5cdc0b0f989747fa68cdc65df8ff0a6893045a70ced7e668e", root: "tasks" },
    tasks: { root: ".", id: "task.name", expectedCount: 66 } } }, verifier: { name: "harbor-shell" },
    run: { timeoutSeconds: 86400, taskIds: null, maxTasks: null } });
  expect(resolveConfig("experiment.yaml", user("terminalbench"), profiles)).toMatchObject({
    benchmark: { config: { dataset: "terminal-bench@2.0" } }, run: { timeoutSeconds: 900 } });
});

test("minimal DeepSWE expands fixed version, defaults and score dimensions without model-token guesses", () => {
  const result = resolveConfig("experiment.yaml", user("deepswe"), profiles);
  expect(result).toMatchObject({ benchmark: { name: "harbor", config: { dataset: "deepswe@1.1", tasks: { expectedCount: 113 } } },
    solver: { name: "simpleagent", service: "default" }, environment: { name: "docker" }, scheduler: { name: "local", config: { concurrency: 1 } },
    run: { onError: "continue", taskIds: null, maxTasks: null, timeoutSeconds: 18000 }, output: { directory: resolve("results/deepswe/experiment") } });
  expect(result.services.default).not.toHaveProperty("maxTokens");
  expect(result.metrics[0]).toEqual({ name: "harbor-score", config: { dimensions: ["f2p", "p2p", "partial"] } });
});

test.each([["code", 4500, 80], ["office", 4500, 50], ["web", 10000, 70], ["security", 36000, 60]])("WorkBuddy %s preserves native verifier defaults", (scenario, timeout, count) => {
  const result = resolveConfig("experiment.yaml", user({ name: "workbuddy", scenario }), profiles);
  expect(result.run.timeoutSeconds).toBe(timeout);
  expect(result.benchmark.config.tasks).toMatchObject({ expectedCount: count });
  if (scenario === "web") expect(result.verifier).toMatchObject({ name: "harbor-python", service: "default", config: { requireService: true } });
  else expect(result.verifier?.service).toBeUndefined();
  if (scenario === "security") expect(result.benchmark.config.source).toMatchObject({ hostPlatform: "linux" });
});

test("default WorkBuddy selects code and rejects unsupported selectors", () => {
  expect(resolveConfig("experiment.yaml", user("workbuddy"), profiles).benchmark.config.dataset).toBe("wb-bench-code-v1.0");
  expect(() => resolveConfig("experiment.yaml", user({ name: "deepswe", version: "2" }), profiles)).toThrow(/unknown version/);
  expect(() => resolveConfig("experiment.yaml", user({ name: "workbuddy", scenario: "sec" }), profiles)).toThrow(/unknown scenario/);
});

test("nested solver, flat fields and score alias normalize equivalently to explicit configuration", () => {
  const a = resolveConfig("experiment.yaml", user({ name: "deepswe", solver: { name: "agentbundle", config: { path: "./bundle" } } },
    { scheduler: { concurrency: 8 }, environment: { platform: "linux/amd64" }, metrics: ["deepswe-score", "usage"] }), profiles);
  const b = resolveConfig("experiment.yaml", user({ name: "deepswe", version: "1.1", solver: { name: "agentbundle", service: "default", config: { path: "./bundle" } } },
    { scheduler: { name: "local", config: { concurrency: 8 } }, environment: { name: "docker", config: { platform: "linux/amd64" } },
      metrics: [{ name: "harbor-score", config: { dimensions: ["f2p", "p2p", "partial"] } }, "usage"], run: { onError: "continue", timeoutSeconds: 18000 } }), profiles);
  expect(fingerprint(a)).toBe(fingerprint(b));
  expect(() => user("deepswe", { scheduler: { concurrency: 2, config: { concurrency: 3 } } })).toThrow(/duplicates/);
  expect(() => user("deepswe", { environment: { platfrom: "linux/amd64" } })).toThrow(/unknown field/);
});

test("default service chooses default, then unique, and errors for ambiguity or invalid routes", () => {
  const sole = parseUserConfig({ services: { main: services.default }, benchmark: "deepswe" });
  expect(resolveConfig("experiment.yaml", sole, profiles).solver.service).toBe("main");
  const many = parseUserConfig({ services: { a: services.default, b: services.default }, benchmark: "deepswe" });
  expect(() => resolveConfig("experiment.yaml", many, profiles)).toThrow(/No default service/);
  expect(() => resolveConfig("experiment.yaml", user({ name: "deepswe", solver: { service: "missing" } }), profiles)).toThrow(/unknown service/);
});

test("profile inheritance, implementation changes and CLI precedence are isolated across resolutions", () => {
  const extra: ConfigProfile = { id: "custom", role: "benchmark", extends: "deepswe", plugin: { name: "fixture", config: { flag: true } },
    defaults: { scheduler: { name: "local", config: { concurrency: 2 } } } };
  const result = resolveConfig("experiment.yaml", user({ name: "custom", solver: { name: "agentbundle", config: { path: "./bundle" } } }, { scheduler: { concurrency: 4 } }), [...profiles, extra], { model: "override" });
  expect(result.benchmark).toEqual({ name: "fixture", config: { flag: true } });
  expect(result.scheduler.config.concurrency).toBe(4);
  expect(result.services.default?.name).toBe("override");
  expect(resolveConfig("experiment.yaml", user("deepswe"), profiles).services.default?.name).toBe("fixture");
  expect(() => resolveConfig("experiment.yaml", user("custom"), [...profiles, { ...extra, extends: "custom" }])).toThrow(/cycle/);
  expect(() => resolveConfig("experiment.yaml", user("custom"), [...profiles, { ...extra, extends: "absent" }])).toThrow(/unknown benchmark profile/);
  expect(() => resolveConfig("experiment.yaml", user("custom"), [...profiles, extra, extra])).toThrow(/duplicate profile/);
});

test("solver profiles resolve public aliases into registered implementations", () => {
  const extra: ConfigProfile = { id: "my-agent", role: "solver", plugin: { name: "agentbundle", config: { path: "./default-bundle" } } };
  expect(resolveConfig("experiment.yaml", user({ name: "deepswe", solver: { name: "my-agent", config: { path: "./override-bundle" } } }), [...profiles, extra]).solver)
    .toEqual({ name: "agentbundle", config: { path: "./override-bundle" }, service: "default" });
});

test("overriding only a service preserves Benchmark-owned solver defaults over the Solver profile", () => {
  const solver: ConfigProfile = { id: "default-agent", role: "solver", plugin: { name: "agentbundle", config: { path: "./solver-default" } } };
  const benchmark: ConfigProfile = { id: "with-agent", role: "benchmark", extends: "deepswe", defaults: {
    benchmark: { solver: { name: "default-agent", config: { path: "./benchmark-default" } } },
  } };
  const config = parseUserConfig({ services: { ...services, other: services.default }, benchmark: { name: "with-agent", solver: { service: "other" } } });
  expect(resolveConfig("experiment.yaml", config, [...profiles, solver, benchmark]).solver).toEqual({ name: "agentbundle", config: { path: "./benchmark-default" }, service: "other" });
});

test("metric aliases expose their inherited dimensions with accurate profile provenance", async () => {
  const path = await file({ services, benchmark: "deepswe", metrics: ["usage", "deepswe-score"] });
  const config = await loadConfig(path, {}, {}, { allowMissingAuth: true });
  expect(explainConfig(config)).toContain('metrics.1.config.dimensions.0: "f2p"  [profile deepswe]');
});

test("Office explicit judge route opts in while Web can use an independent service", () => {
  for (const scenario of ["office", "web"]) {
    const config = parseUserConfig({ services: { ...services, judge: services.default }, benchmark: { name: "workbuddy", scenario, verifier: { service: "judge" } } });
    expect(resolveConfig("experiment.yaml", config, profiles).verifier?.service).toBe("judge");
  }
});

test("WorkBuddy profiles constrain incompatible Code tasks without assuming Office deliverable paths", () => {
  const office = resolveConfig("experiment.yaml", user({ name: "workbuddy", scenario: "office" }), profiles);
  expect(office.benchmark.config.defaults ?? {}).not.toHaveProperty("artifactPaths");
  const code = resolveConfig("experiment.yaml", user({ name: "workbuddy", scenario: "code" }), profiles);
  expect(code.environment.config.buildPipConstraints).toEqual({
    "workbuddy/bug_fix-medium-incorrect_linenos_on_fstring": ["pytest<8"],
    "workbuddy/feature-medium-add_support_for_dependencies": ["pytest<8", "anyio<4.15"],
  });
  expect(code.environment.config.containerEnv).toBeUndefined();
  expect(office.environment.config.buildPipConstraints).toBeUndefined();
  const custom = resolveConfig("experiment.yaml", user({ name: "workbuddy", scenario: "code" }, {
    environment: { name: "docker", config: { buildPipConstraints: { "workbuddy/feature-medium-add_support_for_dependencies": [] } } },
  }), profiles);
  expect(custom.environment.config.buildPipConstraints).toMatchObject({ "workbuddy/feature-medium-add_support_for_dependencies": [] });
});

test("loading and exporting preserve credentials as references and round trip fingerprints", async () => {
  const path = await file({ services, benchmark: "deepswe" });
  const loaded = await loadConfig(path, {}, { TEST_MODEL_KEY: "do-not-export-me" });
  const exported = await file(exportConfig(loaded));
  const reloaded = await loadConfig(exported, {}, { TEST_MODEL_KEY: "do-not-export-me" });
  expect(fingerprint(loaded.experiment)).toBe(fingerprint(reloaded.experiment));
  expect(JSON.stringify(loaded.persisted)).not.toContain("do-not-export-me");
  expect(explainConfig(loaded)).toContain("profile deepswe@1.1");
  expect(explainConfig(loaded)).toContain("[generated]");
  expect(explainConfig(loaded)).toContain('services.default.model: "fixture"  [user YAML]');
  const view = await loadConfig(path, { model: "other" }, {}, { allowMissingAuth: true });
  expect(explainConfig(view)).toContain('services.default.model: "other"  [CLI override]');
});

test("rejects legacy YAML rather than maintaining a second parser", async () => {
  const path = await file({ services, benchmarks: [{ name: "gsm8k" }] });
  await expect(loadConfig(path, {}, {})).rejects.toThrow(/unknown field.*benchmarks/);
  expect(resolveInput("experiment.yaml", user("workbuddy"), profiles).source.run).toMatchObject({ onError: "continue" });
});

test("Ray shorthand selects managed local Jobs and keeps scheduling parameters", () => {
  const { source, origins } = resolveInput("experiment.yaml", user("deepswe", { scheduler: { name: "ray", concurrency: 4, nodes: 2 } }), profiles);
  expect(source.deployment).toMatchObject({ kind: "ray-jobs", managedLocal: true, endpoint: "https://localhost:9443" });
  expect(source.scheduler).toEqual({ name: "ray", config: { concurrency: 4, nodes: 2 } });
  expect(origins["deployment.managedLocal"]).toBe("framework default");
  expect(origins["scheduler.config.concurrency"]).toBe("user YAML");
  expect(resolveInput("experiment.yaml", user("deepswe", { scheduler: "ray" }), profiles).source.deployment).toEqual(source.deployment);
});

test("Local defaults and explicit Ray Client connections do not add a deployment", () => {
  expect(resolveInput("experiment.yaml", user("deepswe"), profiles).source).not.toHaveProperty("deployment");
  expect(resolveInput("experiment.yaml", user("deepswe", { scheduler: { concurrency: 4 } }), profiles).source.scheduler)
    .toEqual({ name: "local", config: { concurrency: 4 } });
  const { source } = resolveInput("experiment.yaml", user("deepswe", { scheduler: { name: "ray", concurrency: 4, nodes: 2,
    config: { endpoint: "local", collector: { certFile: "./cert.pem", keyFile: "./key.pem" } } } }), profiles);
  expect(source).not.toHaveProperty("deployment");
  expect(source.scheduler).toMatchObject({ config: { concurrency: 4, nodes: 2, endpoint: "local" } });
});

test("explicit Jobs connections keep their endpoint and do not start managed local clusters by default", () => {
  const { source, origins } = resolveInput("experiment.yaml", user("deepswe", { scheduler: "ray",
    deployment: { kind: "ray-jobs", endpoint: "https://cluster.invalid", caFile: "./cluster-ca.pem" } }), profiles);
  expect(source.deployment).toMatchObject({ endpoint: "https://cluster.invalid", caFile: "./cluster-ca.pem", managedLocal: false });
  expect(origins["deployment.endpoint"]).toBe("user YAML");
  expect(resolveInput("experiment.yaml", user("deepswe", { scheduler: "ray", deployment: { kind: "ray-jobs" } }), profiles).source.deployment)
    .toMatchObject({ endpoint: "https://localhost:9443", managedLocal: false });
  expect(() => resolveInput("experiment.yaml", user("deepswe", { deployment: { kind: "ray-jobs" } }), profiles)).toThrow(/requires scheduler: ray/);
  expect(() => resolveInput("experiment.yaml", user("deepswe", { scheduler: { name: "ray", config: { collector: {} } } }), profiles))
    .toThrow(/belongs to the coordinator/);
});

test("Ray shorthand equals explicit local deployment, exports with provenance and reloads", async () => {
  const input = { services, benchmark: "deepswe", scheduler: { name: "ray", concurrency: 4 } };
  const path = await file(input);
  const loaded = await loadConfig(path, {}, {}, { allowMissingAuth: true });
  const explicit = await loadConfig(await file({ ...input, deployment: { kind: "ray-jobs", managedLocal: true } }), {}, {}, { allowMissingAuth: true });
  expect(loaded.deployment).toEqual(explicit.deployment);
  expect(fingerprint(loaded.experiment)).toBe(fingerprint(explicit.experiment));
  expect(explainConfig(loaded)).toContain('deployment.managedLocal: true  [framework default]');
  const reloaded = await loadConfig(await file(exportConfig(loaded)), {}, {}, { allowMissingAuth: true });
  expect(reloaded.deployment).toEqual(loaded.deployment);
  expect(fingerprint(reloaded.experiment)).toBe(fingerprint(loaded.experiment));
  expect(await readFile(path, "utf8")).not.toContain("deployment:");
  const coordinator = await loadSavedConfig(await file(loaded.persisted), {}, { allowMissingAuth: true, validatePlugins: false });
  expect(coordinator.deployment).toBeUndefined();
  expect(coordinator.experiment.scheduler).toEqual(loaded.experiment.scheduler);
});

test("packaged profiles participate in byte-level provenance", async () => {
  const manifest = JSON.parse(await readFile(resolve("dist/package-provenance.json"), "utf8"));
  expect(Object.keys(manifest.files)).toContain("plugins/benchmarks/agent-harness/profiles/workbuddy.yaml");
});
