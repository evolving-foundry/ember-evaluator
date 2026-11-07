import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { RunStore } from "ember-evaluator";
import { mixedSnapshot } from "../../../tests/fixtures/results/mixed-run/fixture.js";
import { parseCommand } from "../../../src/cli-commands.js";
import { readPluginCatalog } from "../../../src/plugin-catalog.js";
import { loadCliExtensions } from "../../../src/plugin-cli.js";
import { TracerClient } from "../client.js";
import { parseTracerConfig, parseTracerOptions } from "../config.js";
import { TracerStore } from "../store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("plugin owns --tracer with and without URL and contributes help", async () => {
  // Declarative manifest flags replace the retired extendCommand hook; skip the optional CLI module.
  const catalog = readPluginCatalog()
    .filter(plugin => plugin.id === "tracer")
    .map(plugin => ({ id: plugin.id, version: plugin.version, entry: plugin.entry, ...(plugin.flags ? { flags: plugin.flags } : {}) }));
  const extensions = await loadCliExtensions(undefined, catalog);
  expect(parseCommand(["run", "x", "--tracer"], extensions)).toMatchObject({ overrides: { plugins: [{ id: "tracer", config: {} }] } });
  expect(parseCommand(["run", "x", "--tracer", "http://localhost:9000"], extensions)).toMatchObject({ overrides: { plugins: [{ id: "tracer", config: { url: "http://localhost:9000" } }] } });
  expect(parseCommand(["run", "--help"], extensions)).toMatchObject({ kind: "help", text: expect.stringContaining("--tracer [url]") });
  expect(() => parseCommand(["run", "x", "--tracer"])).toThrow(/unknown option/);
  expect(() => parseCommand(["run", "x", "--tracer", "--tracer"], extensions)).toThrow(/more than once|Repeated/);
});

test("persisted tracer options reject literal secrets and credential-bearing endpoints", () => {
  expect(parseTracerOptions({ tokenEnv: "TRACER_TOKEN", url: "https://trace.test" })).toEqual({ tokenEnv: "TRACER_TOKEN", url: "https://trace.test" });
  expect(() => parseTracerOptions({ token: "private" })).toThrow(/tokenEnv/);
  expect(() => parseTracerOptions({ url: "https://user:pass@trace.test" })).toThrow(/credential/);
});

test("tracer mirrors accepted remote evidence and preserves absent Store capabilities", async () => {
  await mkdir(resolve(".scratch"), { recursive: true });
  const root = await mkdtemp(resolve(".scratch/tracer-store-")); roots.push(root);
  const requests: { path: string; text: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, text: Buffer.concat(chunks).toString() });
    response.setHeader("content-type", "application/json");
    response.end(request.url === "/healthz" ? '{"ok":true}' : "{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const client = new TracerClient(parseTracerConfig({ url: `http://127.0.0.1:${address.port}`, autostart: false }), () => {});
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const inner: RunStore = {
    async create() {}, async open() { return mixedSnapshot.run; }, async allocate() { return paths; },
    async listAttempts() { return []; }, async updateRun() {}, async commit() {},
    async snapshot() { return mixedSnapshot; }, async saveReportBundle() {}, async close() {},
  };
  const bare = new TracerStore(inner, client, () => {});
  expect(bare.importAttempt).toBeUndefined();
  expect(bare.currentTaskResult).toBeUndefined();
  expect(bare.updateRemoteAttempt).toBeUndefined();
  expect(bare.controlDirectory).toBeUndefined();
  let accepted = false;
  inner.importAttempt = async () => accepted;
  let directory = "";
  Object.defineProperty(inner, "controlDirectory", { get: () => directory });
  const store = new TracerStore(inner, client, () => {});
  expect(store.controlDirectory).toBe("");
  directory = root;
  expect(store.controlDirectory).toBe(root);
  try {
    await mkdir(paths.agent);
    await writeFile(join(paths.agent, "trajectory.jsonl"), '{"seq":1,"type":"start"}\n');
    const record = mixedSnapshot.records[0]!;
    const files = { schemaVersion: 1 as const, files: [], missing: [] };
    expect(await store.importAttempt!(record, files, root)).toBe(false);
    expect(requests).toEqual([]);
    accepted = true;
    expect(await store.importAttempt!(record, files, root)).toBe(true);
    expect(requests.some(item => item.text.includes('"type":"start"'))).toBe(true);
    expect(requests.some(item => item.text.includes(record.key.taskId))).toBe(true);
  } finally {
    await store.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
