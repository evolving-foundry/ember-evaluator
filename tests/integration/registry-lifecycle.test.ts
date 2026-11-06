import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { bootstrap, bootstrapBenchmark } from "../../src/application/plugins/bootstrap.js";
import { loadConfig } from "../../src/application/config.js";

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
    for (const assemble of [bootstrap, bootstrapBenchmark])
      await expect(assemble(loaded, root, patchPath)).rejects.toThrow(/judgeService references unknown service missing/);
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
