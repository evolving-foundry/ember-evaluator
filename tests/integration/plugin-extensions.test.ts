import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { parseCommand } from "../../src/cli-commands.js";
import { runCli } from "../../src/cli.js";
import { loadCliExtensions, type CliExtensions } from "../../src/plugin-cli.js";
import { readPluginCatalog } from "../../src/plugin-catalog.js";
import { openPluginRegistry } from "../../src/plugin-runtime.js";
import { restorePluginActivations } from "../../src/plugin-activation.js";
import { validatePortablePluginActivations, assertWorkerVersions } from "../../src/adapters/ray/protocol.js";
import * as catalogModule from "../../src/plugin-catalog.js";
import { Evaluator } from "../../src/evaluator.js";
import { retryRun } from "../../src/retry.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function temporary() {
  await mkdir(resolve(".scratch"), { recursive: true });
  const root = await mkdtemp(resolve(".scratch/plugin-extensions-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function experiment(mode = "pass") {
  const root = await temporary();
  await copyFile(resolve("tests/fixtures/cli/plugin.mjs"), join(root, "components.mjs"));
  await copyFile(resolve("tests/fixtures/plugins/extension/plugin.mjs"), join(root, "extension.mjs"));
  const patch = join(root, "patch.json"), config = join(root, "experiment.json");
  await writeFile(patch, JSON.stringify([{ insert: [
    { id: "test-components", name: "./components.mjs" }, { id: "audit", name: "./extension.mjs" },
  ] }]));
  await writeFile(config, JSON.stringify({
    services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${EXTENSION_KEY}" } },
    benchmark: { name: "cli-fixture", solver: { name: "cli-fixture", config: { mode } } },
    environment: "local", output: { directory: "./results" },
  }));
  vi.stubEnv("EXTENSION_KEY", "fixture-secret");
  return { root, patch, config };
}

test("an option-only patch plugin extends parsing and restores its configuration on resume", async () => {
  const { root, patch, config } = await experiment();
  const extensions = await loadCliExtensions(patch);
  expect(parseCommand(["run", config, "--audit-url", "https://audit.invalid"], extensions)).toMatchObject({
    overrides: { plugins: [{ id: "audit", config: { url: "https://audit.invalid" } }] },
  });
  const errors: string[] = [];
  const io = { out() {}, error(text: string) { errors.push(text); } };
  expect(await runCli(["run", config, "--patch", patch, "--audit-url", "https://audit.invalid"], io), errors.join("\n")).toBe(0);
  const runId = (await readdir(join(root, "results")))[0]!;
  const manifest = JSON.parse(await readFile(join(root, "results", runId, "manifest.json"), "utf8"));
  expect(manifest.pluginRuntime.plugins).toEqual([{ id: "audit", config: { url: "https://audit.invalid" } }]);
  expect(await runCli(["run", config, "--patch", patch, "--resume", runId], io), errors.join("\n")).toBe(0);
  const calls = (await readFile(join(root, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(call => call.operation)).toEqual(["create", "open"]);
  expect(calls.every(call => call.config.url === "https://audit.invalid")).toBe(true);
});

test("retry restores extension options instead of constructing the decorator with defaults", async () => {
  const { root, patch, config } = await experiment("nested-error");
  const io = { out() {}, error() {} };
  expect(await runCli(["run", config, "--patch", patch, "--audit-url", "https://retry.invalid"], io)).toBe(1);
  const runId = (await readdir(join(root, "results")))[0]!;
  await retryRun({ run: join(root, "results", runId), taskIds: [] }, new AbortController().signal, () => {});
  const calls = (await readFile(join(root, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.every(call => call.config.url === "https://retry.invalid")).toBe(true);
});

test("commands and option aliases cannot replace builtin CLI behavior", () => {
  const commands: CliExtensions = { commands: [{ name: "run", description: "override", async run() { return { ok: true, status: 0 }; } }], options: [] };
  expect(() => parseCommand(["run", "x"], commands)).toThrow(/reserved/);
  for (const flags of ["--resume", "-h, --other", "--help", "--api-key-env <value>"]) {
    expect(() => parseCommand(["run", "x"], { commands: [], options: [{ id: "audit", command: "run", option: { flags, description: "test", configure() {} } }] })).toThrow(/reserved/);
  }
  expect(() => parseCommand(["run", "x", "--unknown"])).toThrow(/unknown option/);
});

test("build indexes plugins without CLI and preserves installed entry paths outside builtin components", async () => {
  const root = await temporary();
  const plugin = join(root, "plugins/environments");
  await mkdir(plugin, { recursive: true });
  await mkdir(join(root, "dist/plugins/environments"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", type: "module" }));
  await writeFile(join(root, "dist/plugins/environments/core.js"), "builtin");
  await writeFile(join(plugin, "entry.js"), "export function apply() {}\n");
  await writeFile(join(plugin, "ember-plugin.json"), JSON.stringify({ id: "environments", entry: "./entry.js", build: { install: ["entry.js"] } }));
  const builder = pathToFileURL(resolve("scripts/build-plugins.mjs")).href;
  await execute(process.execPath, ["--input-type=module", "-e", `import { buildPlugins } from ${JSON.stringify(builder)}; await buildPlugins(process.argv[1]);`, root]);
  const catalog = readPluginCatalog(root);
  expect(catalog).toEqual([{ id: "environments", version: "1.2.3", entry: join(root, "dist/external-plugins/environments/entry.js") }]);
  expect(await readFile(join(root, "dist/plugins/environments/core.js"), "utf8")).toBe("builtin");
  await rm(join(root, "plugins"), { recursive: true });
  expect(readPluginCatalog(root)).toEqual(catalog);
});

test("a source checkout resolves manifest entries to the files they compile from", async () => {
  const root = await temporary();
  const plugin = join(root, "plugins/audit");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
  await writeFile(join(plugin, "index.ts"), "export function apply() {}\n");
  await writeFile(join(plugin, "cli-register.ts"), "export {};\n");
  await writeFile(join(plugin, "ember-plugin.json"), JSON.stringify({
    id: "audit", entry: "./dist/index.js", cli: "./dist/cli-register.js",
  }));
  expect(readPluginCatalog(root)).toEqual([{
    id: "audit", version: "1.0.0", entry: join(plugin, "index.ts"), cli: join(plugin, "cli-register.ts"),
  }]);
});

test("resume rejects changed options and Ray rejects client paths and secrets", () => {
  const saved = [{ id: "audit", config: { url: "https://audit.invalid", tokenEnv: "AUDIT_TOKEN" } }];
  expect(restorePluginActivations(saved, undefined)).toEqual(saved);
  expect(() => restorePluginActivations(saved, [{ id: "audit", config: {} }])).toThrow(/differ/);
  expect(validatePortablePluginActivations(saved)).toEqual(saved);
  for (const config of [{ db: "/home/client/trace.db" }, { token: "private" }, { url: "https://u:p@host" }])
    expect(() => validatePortablePluginActivations([{ id: "audit", config }])).toThrow();
});

test("worker can register recorded installed plugins without activating their decorators", async () => {
  const id = readPluginCatalog().find(plugin => plugin.cli)?.id;
  expect(id).toBeDefined();
  const coordinator = await openPluginRegistry(undefined, { plugins: [id!] });
  const worker = await openPluginRegistry();
  try {
    await worker.loadRecordedPlugins(coordinator.pluginVersions);
    expect(() => assertWorkerVersions(coordinator.pluginVersions, worker.pluginVersions, "same", "same")).not.toThrow();
    expect(worker.prepareStoreDecorators([])).toEqual([]);
  } finally { await coordinator.dispose(); await worker.dispose(); }
});


test("a newly packaged plugin contributes a command and option without host changes", async () => {
  const root = await temporary();
  const plugin = join(root, "plugins/audit");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
  await writeFile(join(plugin, "index.js"), `export function apply() {}
export function registerCli(cli) {
    cli.addCommand({name: "audit", description: "fixture", async run(argv, io) { io.out(argv.join(" ")); return {ok:true,status:0}; }});
    cli.extendCommand("run", {flags:"--audit [url]",description:"fixture",configure(value, activation) {activation.enable(typeof value === "string" ? {url:value} : {});}});
  }`);
  await writeFile(join(plugin, "ember-plugin.json"), JSON.stringify({ id: "audit", entry: "index.js", cli: "index.js", build: { install: ["index.js"] } }));
  const builder = pathToFileURL(resolve("scripts/build-plugins.mjs")).href;
  await execute(process.execPath, ["--input-type=module", "-e", `import {buildPlugins} from ${JSON.stringify(builder)}; await buildPlugins(process.argv[1]);`, root]);
  await rm(join(root, "plugins"), { recursive: true });
  const extensions = await loadCliExtensions(undefined, readPluginCatalog(root));
  expect(parseCommand(["run", "x", "--audit", "https://audit.test"], extensions)).toMatchObject({overrides:{plugins:[{id:"audit",config:{url:"https://audit.test"}}]}});
  const command = parseCommand(["audit", "hello", "--patch", "explicit.json"], extensions);
  expect(command.kind).toBe("plugin");
  if (command.kind !== "plugin") throw new Error("Expected plugin command");
  const output: string[] = [];
  await command.plugin.run(command.argv, {out: text => output.push(text), error() {}}, new AbortController().signal);
  expect(output).toEqual(["hello"]);
});


test("a manifest can declare run flags without shipping CLI code", async () => {
  const root = await temporary();
  const plugin = join(root, "plugins/audit");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
  await writeFile(join(plugin, "index.js"), "export function apply() {}\n");
  await writeFile(join(plugin, "ember-plugin.json"), JSON.stringify({
    id: "audit", entry: "index.js",
    flags: [{ command: "run", flag: "--audit [url]", description: "fixture", config: "url" }],
    build: { install: ["index.js"] },
  }));
  const builder = pathToFileURL(resolve("scripts/build-plugins.mjs")).href;
  await execute(process.execPath, ["--input-type=module", "-e", `import {buildPlugins} from ${JSON.stringify(builder)}; await buildPlugins(process.argv[1]);`, root]);
  const extensions = await loadCliExtensions(undefined, readPluginCatalog(root));
  expect(parseCommand(["run", "x", "--audit", "https://audit.test"], extensions)).toMatchObject({ overrides: { plugins: [{ id: "audit", config: { url: "https://audit.test" } }] } });
  expect(parseCommand(["run", "x", "--audit"], extensions)).toMatchObject({ overrides: { plugins: [{ id: "audit", config: {} }] } });
});

test("installed plugins support default exports and offline reporting without their source checkout", async () => {
  const { root, patch, config } = await experiment();
  const entry = join(root, "report.mjs");
  await writeFile(entry, `export default {inject:["evaluator"], apply(ctx) {
    ctx.evaluator.register("reporter", "installed-report", value=>value, ()=>({async render(){return "installed report";}}));
  }};`);
  vi.spyOn(catalogModule, "readPluginCatalog").mockReturnValue([{id:"installed-report",version:"1",entry}]);
  const input = JSON.parse(await readFile(config, "utf8"));
  input.reporter = "installed-report";
  await writeFile(config, JSON.stringify(input));
  const sdk = new Evaluator();
  const result = await sdk.run({configPath:config,patchPath:patch,overrides:{plugins:[{id:"installed-report",config:{}}]}});
  if (result.kind !== "local") throw new Error("Expected local result");
  expect(await readFile(await sdk.report(result.runDirectory), "utf8")).toContain("\ninstalled report\n");
});
