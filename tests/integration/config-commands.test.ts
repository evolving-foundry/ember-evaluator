import { Context } from "@deepseek-ai/cordis";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { apply as registryPlugin } from "../../src/application/plugins/registry.js";
import { readProfileDirectory } from "../../src/infrastructure/profiles/read.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "config-commands-")); roots.push(root);
  const config = { services: { default: { model: "fixture", base_url: "https://model.invalid", api_key: "${UNSET_CONFIG_TEST_KEY}" } }, benchmark: "deepswe" };
  const path = join(root, "experiment.yaml"); await writeFile(path, stringify(config));
  const stdout: string[] = [], stderr: string[] = [];
  return { root, path, config, stdout, stderr, io: { out: (line: string) => { stdout.push(line); }, error: (line: string) => { stderr.push(line); } } };
}

test("inspect shows reloadable configuration without credentials or dataset I/O", async () => {
  const { path, stdout, stderr, io } = await setup();
  vi.stubEnv("UNSET_CONFIG_TEST_KEY", undefined);
  expect(await runCli(["inspect", path], io)).toBe(0);
  expect(JSON.parse(stdout.at(-1) ?? "").experiment.services.default.model).toBe("fixture");
  expect(await runCli(["inspect", path], io)).toBe(0);
  const exported = JSON.parse(stdout.at(-1) ?? "").experiment;
  expect(exported.benchmark.solver).toEqual({ name: "simpleagent", config: {}, service: "default" });
  expect(exported.services.default.api_key).toBe("${UNSET_CONFIG_TEST_KEY}");
  expect(stderr.join("\n")).not.toMatch(/source|enumerate|bootstrap|ERROR/);
});

test("inspect explain, export and reload offset and maxTasks", async () => {
  const { root, path, config, stdout, stderr, io } = await setup();
  await writeFile(path, stringify({ ...config, run: { offset: 10, maxTasks: 5 } }));
  expect(await runCli(["inspect", path], io), stderr.join("\n")).toBe(0);
  expect(JSON.parse(stdout.at(-1) ?? "").experiment.run.offset).toBe(10);
  expect(await runCli(["inspect", path], io), stderr.join("\n")).toBe(0);
  const exported = stringify(JSON.parse(stdout.at(-1) ?? "").experiment);
  expect(parse(exported).run).toMatchObject({ offset: 10, maxTasks: 5 });
  const resolvedPath = join(root, "resolved.yaml");
  await writeFile(resolvedPath, exported);
  expect(await runCli(["inspect", resolvedPath], io), stderr.join("\n")).toBe(0);
  expect(JSON.parse(stdout.at(-1) ?? "").experiment.run).toMatchObject({ offset: 10, maxTasks: 5 });
});

test.each(["local", "ray"])("%s inspect do not call factories, resolve datasets or instantiate execution resources", async scheduler => {
  const { root, path, config, stdout, io } = await setup();
  await mkdir(join(root, "profiles"));
  // A dataset author can ship just a declaration; the generic Harbor implementation supplies the behavior.
  await writeFile(join(root, "profiles", "fixture.yaml"), stringify({ id: "fixture-profile", role: "benchmark", extends: "harbor",
    plugin: { name: "factory-trap", config: {} }, defaults: { run: { timeoutSeconds: 42 } } }));
  const profile = (await readProfileDirectory(new URL(`file:///${root.replaceAll("\\", "/")}/profiles/`)))[0];
  expect(profile?.id).toBe("fixture-profile");
  await writeFile(join(root, "plugin.mjs"), `export const inject = ["evaluator"]; export function apply(ctx) {
    ctx.evaluator.registerProfile(${JSON.stringify(profile)});
    ctx.evaluator.register("benchmark", "factory-trap", value => value, () => { throw new Error("FACTORY_CALLED"); });
  }`);
  const patchPath = join(root, "patch.yaml");
  await writeFile(patchPath, stringify([{ insert: [{ id: "fixture-provider", name: "./plugin.mjs" }] }]));
  await writeFile(path, stringify({ ...config, benchmark: "fixture-profile", scheduler }));
  expect(await runCli(["inspect", path, "--patch", patchPath], io)).toBe(0);
  const exported = JSON.parse(stdout[0] ?? "").experiment;
  expect(exported.run.timeoutSeconds).toBe(42);
  if (scheduler === "ray") {
    expect(exported.deployment).toMatchObject({ kind: "ray-jobs", managedLocal: true });
    expect(await runCli(["inspect", path, "--patch", patchPath], io)).toBe(0);
    expect(JSON.parse(stdout.at(-1) ?? "").experiment.deployment.managedLocal).toBe(true);
  } else expect(exported.deployment).toBeUndefined();
  expect(await runCli(["inspect", path], io)).toBe(2);
});

test("profile registrations roll back with their Cordis plugin lifecycle", async () => {
  const ctx = new Context(); await ctx.plugin(registryPlugin);
  try {
    const plugin = { inject: ["evaluator"], apply(context: Context) {
      context.evaluator.registerProfile({ id: "temporary", role: "benchmark", plugin: { name: "harbor", config: {} } });
    } };
    const fiber = ctx.plugin(plugin); await fiber;
    expect(ctx.evaluator.profiles().map(profile => profile.id)).toEqual(["temporary"]);
    await fiber.dispose(); expect(ctx.evaluator.profiles()).toEqual([]);
    await expect(ctx.plugin({ inject: ["evaluator"], apply(context: Context) {
      context.evaluator.registerProfile({ id: "rolled-back", role: "benchmark", plugin: { name: "harbor", config: {} } });
      throw new Error("apply failed");
    } })).rejects.toThrow("apply failed");
    expect(ctx.evaluator.profiles()).toEqual([]);
  } finally { await ctx.fiber.dispose(); }
});

test("inspect preserves credential references without exposing their values", async () => {
  const { path, stdout, stderr, io } = await setup();
  vi.stubEnv("UNSET_CONFIG_TEST_KEY", "never-echo-this-key");
  expect(await runCli(["inspect", path], io)).toBe(0);
  expect(stdout.join("\n")).not.toContain("never-echo-this-key");
  expect(stdout.join("\n")).toContain("${UNSET_CONFIG_TEST_KEY}");
  expect(stderr).toEqual([]);
});

test("resolved relative paths retain the experiment-directory convention", async () => {
  const { root, path, config, stdout, io } = await setup();
  await writeFile(path, stringify({ ...config, benchmark: { name: "deepswe", solver: { name: "agentbundle", config: { path: "./agent" } } }, output: { directory: "./out" } }));
  expect(await runCli(["inspect", path], io)).toBe(0);
  const result = JSON.parse(stdout[0] ?? "").experiment;
  expect(result.output.directory).toBe(join(root, "out"));
  expect(result.benchmark.solver.config.path).toBe("./agent");
  expect(await readFile(path, "utf8")).toContain("./agent");
});

test("the built CLI resolves filename-based output from an unrelated working directory", async () => {
  const { root, path } = await setup();
  const network = join(root, "network.yaml");
  await writeFile(network, "{}");
  const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/cli.js"), "inspect", path, "--network", network], { cwd: root });
  expect(JSON.parse(stdout).experiment.output.directory).toBe(resolve("results/deepswe/experiment"));
});

test("resolve preserves public credential-variable names without model budgets", async () => {
  const { path, config, stdout, io } = await setup();
  await writeFile(path, stringify({ ...config,
    benchmark: { name: "deepswe", solver: { name: "agentbundle", config: { path: "./bundle", maxTokens: 12345 } } },
    scheduler: { name: "ray", nodes: 2 },
    deployment: { kind: "ray-jobs", endpoint: "https://cluster.invalid", caFile: "./ca.pem", tokenEnv: "GATEWAY_AUTH_KEY" },
  }));
  expect(await runCli(["inspect", path], io)).toBe(0);
  const result = JSON.parse(stdout[0] ?? "").experiment;
  expect(result.deployment.tokenEnv).toBe("GATEWAY_AUTH_KEY");
  expect(result.benchmark.solver.config.maxTokens).toBe(12345);
});
