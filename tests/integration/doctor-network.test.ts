import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCli, parseArgs } from "../../src/cli/main.js";
import { diagnoseNetwork } from "../../src/application/diagnostics/network.js";
import { defaultNetworkConfigPath } from "../../src/config/network.js";

vi.mock("../../src/application/diagnostics/network.js", () => ({ diagnoseNetwork: vi.fn() }));
const roots: string[] = [];
beforeEach(() => vi.stubEnv("TEST_KEY", "fixture-secret"));
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("doctor creates the default YAML and names the failed field and recommendation", async () => {
  vi.mocked(diagnoseNetwork).mockImplementation(async (_network, _signal, options) => {
    const probe = { name: "huggingface", location: "fixture", target: "https://huggingface.co/test", route: "direct",
      status: "failed" as const, elapsedMs: 1, evidence: "connect ECONNREFUSED", guidance: { yamlFields: ["sources.huggingface"], action: "Change the source and retry doctor" } };
    options?.progress?.(probe);
    return [probe];
  });
  const root = await mkdtemp(join(tmpdir(), "doctor-network-default-")); roots.push(root);
  const file = join(root, "experiment.yaml");
  await writeFile(file, "services:\n  default:\n    model: fixture\n    base_url: https://model.invalid/v1\n    api_key: ${TEST_KEY}\nbenchmark: gsm8k\nenvironment: local\n");
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["doctor", file], { out: text => out.push(text), error: text => errors.push(text) })).toBe(1);
  const report = JSON.parse(out.at(-1)!);
  expect(report.network).toMatchObject({ configPath: defaultNetworkConfigPath(), status: "failed",
    recommendedCommand: expect.stringContaining("--network"), probes: [expect.objectContaining({ name: "huggingface" })] });
  const defaultConfig = parse(await readFile(defaultNetworkConfigPath(), "utf8"));
  expect(defaultConfig).toMatchObject({ sources: { huggingface: "https://huggingface.co" } });
  expect(errors.join("\n")).toContain(defaultNetworkConfigPath());
  expect(errors.join("\n")).toContain("sources.huggingface");
  expect(errors.join("\n")).toContain("mirrors.yaml");
  expect(() => parseArgs(["doctor"])).toThrow();
}, 30000);

test("experiment doctor preserves configuration checks and uses the selected network YAML", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-network-")); roots.push(root);
  await mkdir(join(root, "data"));
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, "services:\n  default:\n    model: fixture\n    base_url: https://model.invalid/v1\n    api_key: ${TEST_KEY}\nbenchmark: gsm8k\nenvironment: local\n");
  await writeFile(network, "sources:\n  huggingface: https://hub.test\n");
  vi.mocked(diagnoseNetwork).mockImplementation(async (runtime, _signal, options) => {
    expect(runtime.settings.sources.huggingface).toBe("https://hub.test");
    expect(options?.docker).toBe(false);
    return [];
  });
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["doctor", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: "configuration", status: "passed" })]),
    network: { configPath: resolve(network), status: "passed" } });
  vi.mocked(diagnoseNetwork).mockResolvedValue([{ name: "cached", location: "host", target: "fixture", route: "direct", status: "not-checked", elapsedMs: 0, evidence: "cache" }]);
  expect(await runCli(["doctor", file, "--network", network], { out: () => {}, error: () => {} })).toBe(1);
});


test.each(["", "# default sources\n", "{}\n"])("inspect accepts an empty network file (%j) without download probes", async content => {
  const root = await mkdtemp(join(tmpdir(), "inspect-network-")); roots.push(root);
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, "services:\n  default:\n    model: fixture\n    api_key: ${TEST_KEY}\n    base_url: https://model.invalid/v1\nbenchmark: gsm8k\n");
  await writeFile(network, content);
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["inspect", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(diagnoseNetwork).not.toHaveBeenCalled();
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ network: { configPath: network, settings: {
    sources: { huggingface: "https://huggingface.co" }, proxy: { host: { http: null, https: null } },
  } } });
  expect(out.join("\n")).not.toContain("fixture-secret");
});

test("inspect reports environment overrides even with an explicit network file and redacts proxy credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspect-network-env-")); roots.push(root);
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, "services:\n  default:\n    model: fixture\n    api_key: ${TEST_KEY}\n    base_url: https://model.invalid/v1\nbenchmark: gsm8k\n");
  await writeFile(network, "proxy:\n  https: http://yaml.test\nsources:\n  huggingface: https://yaml.test\n");
  vi.stubEnv("HTTPS_PROXY", "http://user:proxy-secret@env.test");
  vi.stubEnv("HF_ENDPOINT", "https://env.test");
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["inspect", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ network: { configPath: network, settings: {
    sources: { huggingface: "https://env.test" }, proxy: { host: { https: "http://redacted:redacted@env.test/" } },
  } } });
  expect(out.join("\n")).not.toContain("proxy-secret");
  expect(diagnoseNetwork).not.toHaveBeenCalled();
});
