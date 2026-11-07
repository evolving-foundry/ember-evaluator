import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { createRunComponents, createBenchmark } from "../../src/application/plugins/create-components.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { loadConfig } from "../../src/application/config.js";
import { previewExperiment } from "../../src/application/inspection.js";

test("Registry disposal releases a simpleagent's staged bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "staging-lifecycle-"));
  const file = join(root, "experiment.yaml");
  await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${KEY}" } },
    benchmark: { name: "gsm8k", solver: { name: "simpleagent", config: { bundle: { path: join(import.meta.dirname, "../fixtures/pi-bundle") } } } } }));
  const config = await loadConfig(file, {}, { KEY: "fixture-key" });
  const components = await bootstrap(config, root);
  try {
    if (!components.solver.runtimeInstallation) throw new Error("Missing Pi runtime installation");
    const installation = await components.solver.runtimeInstallation(AbortSignal.timeout(5000));
    const bundle = installation.files.find(file => file.target === "bundle")?.source;
    if (!bundle) throw new Error("Missing staged bundle");
    await access(bundle);
    await components.dispose();
    await components.dispose();
    await expect(access(bundle)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await components.dispose(); await rm(root, { recursive: true, force: true }); }
});

test.each([{ flags: [] }, { flags: ["--dry-run"] }])("a command shares one registry and releases its effects: $flags", async ({ flags }) => {
  const root = await mkdtemp(join(tmpdir(), "registry-lifecycle-"));
  try {
    const log = join(root, "lifecycle.txt");
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync } from "node:fs";
export const inject = ["evaluator"];
export function apply(ctx) {
  const log = ${JSON.stringify(pathToFileURL(log).href)};
  appendFileSync(new URL(log), "registered\\n");
  ctx.effect(() => () => appendFileSync(new URL(log), "disposed\\n"));
  ctx.evaluator.register("benchmark", "fixture", value => value, () => ({
    async resolveSource() { return { source: "fixture", revision: "1", files: [], metadata: null }; },
    async *enumerate() { throw new Error("fixture enumeration failure"); },
    async prepare() { throw new Error("unused"); },
    async verify() { throw new Error("unused"); }
  }));
}`);
    const patch = join(root, "patch.yaml");
    await writeFile(patch, stringify([{ insert: [{ id: "lifecycle", name: "./plugin.mjs" }] }]));
    const config = join(root, "experiment.yaml");
    await writeFile(config, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
      benchmark: "fixture", output: { directory: "./results" } }));
    const errors: string[] = [];
    expect(await runCli(["run", config, "--patch", patch, "--api-key", "fixture-key", ...flags],
      { out() {}, error: text => { errors.push(text); } })).toBe(2);
    expect(errors.join("\n")).toContain("fixture enumeration failure");
    expect(await readFile(log, "utf8")).toBe("registered\ndisposed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid service references fail before any factory, including standalone assembly", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-validation-"));
  try {
    const log = join(root, "factory.txt");
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync } from "node:fs";
export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.register("verifier", "controlled", value => value, () => {
    appendFileSync(new URL(${JSON.stringify(pathToFileURL(log).href)}), "created");
    throw new Error("verifier factory must not run");
  });
}`);
    const patchPath = join(root, "patch.yaml"), file = join(root, "experiment.yaml");
    await writeFile(patchPath, stringify([{ insert: [{ id: "controlled", name: "./plugin.mjs" }] }]));
    const config = { services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${KEY}" } },
      benchmark: { name: "simpleqa", config: { judgeService: "default" }, verifier: "controlled" } };
    await writeFile(file, stringify(config));
    const loaded = await loadConfig(file, {}, { KEY: "private-key" }, { patchPath });
    loaded.experiment.benchmark.config.judgeService = "missing";
    await expect(bootstrap(loaded, root, patchPath)).rejects.toThrow(/judgeService references unknown service missing/);
    const registry = await openPluginRegistry(patchPath);
    try {
      for (const assemble of [createRunComponents, createBenchmark])
        await expect(assemble(registry, loaded, root)).rejects.toThrow(/judgeService references unknown service missing/);
    } finally { await registry.dispose(); }
    config.benchmark.config.judgeService = "missing";
    await writeFile(file, stringify(config));
    for (const flags of [[], ["--dry-run"]]) {
      const errors: string[] = [];
      expect(await runCli(["run", file, "--patch", patchPath, "--api-key", "private-key", ...flags],
        { out() {}, error: text => { errors.push(text); } })).toBe(2);
      expect(errors.join("\n")).toContain("unknown service missing");
    }
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { kind: "run", fail: false },
  { kind: "run", fail: true },
  { kind: "benchmark", fail: false },
  { kind: "benchmark", fail: true },
])("caller registry releases factory resources after $kind assembly, fail=$fail", async ({ kind, fail }) => {
  const root = await mkdtemp(join(tmpdir(), "factory-ownership-"));
  const resource = join(root, "resource.txt");
  const log = join(root, "lifecycle.txt");
  const patchPath = join(root, "patch.yaml");
  const file = join(root, "experiment.yaml");
  try {
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync, writeFileSync, rmSync } from "node:fs";
export const inject = ["evaluator"];
export function apply(ctx) {
  const log = new URL(${JSON.stringify(pathToFileURL(log).href)});
  appendFileSync(log, "registered\\n");
  ctx.evaluator.register("benchmark", "resource-fixture", config => config, config => {
    const resource = new URL(${JSON.stringify(pathToFileURL(resource).href)});
    writeFileSync(resource, "allocated");
    ctx.effect(() => () => { rmSync(resource); appendFileSync(log, "released\\n"); });
    if (config.fail) throw new Error("factory failed after allocation");
    return {
      async resolveSource() { return { source: "fixture", revision: "1", files: [], metadata: null }; },
      async *enumerate() { yield { id: "a", recordKey: "a" }; },
      async prepare() { throw new Error("unused"); },
      async verify() { throw new Error("unused"); }
    };
  });
}`);
    await writeFile(patchPath, stringify([{ insert: [{ id: "resource-fixture", name: "./plugin.mjs" }] }]));
    await writeFile(file, stringify({ services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
      benchmark: { name: "resource-fixture", config: { fail } } }));
    const registry = await openPluginRegistry(patchPath);
    try {
      const config = await loadConfig(file, {}, {}, { registry, allowMissingAuth: true });
      const assembled = kind === "run"
        ? createRunComponents(registry, config, root).then(components => components.benchmark)
        : createBenchmark(registry, config, root);
      if (fail) await expect(assembled).rejects.toThrow("factory failed after allocation");
      else {
        const benchmark = await assembled;
        expect(await benchmark.resolveSource(null, AbortSignal.timeout(5000))).toMatchObject({ source: "fixture" });
      }
      expect(await readFile(resource, "utf8")).toBe("allocated");
      expect(await readFile(log, "utf8")).toBe("registered\n");
    } finally { await registry.dispose(); }
    await expect(access(resource)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(log, "utf8")).toBe("registered\nreleased\n");

    if (kind === "benchmark" && !fail) {
      await expect(previewExperiment({ file, patchPath, overrides: {},
        onProgress(event) { if (event.phase === "dispose") throw new Error("dispose observer failed"); },
        onDiagnostic() {},
      }, new AbortController().signal)).rejects.toThrow("dispose observer failed");
      await expect(access(resource)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(log, "utf8")).toBe("registered\nreleased\nregistered\nreleased\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
