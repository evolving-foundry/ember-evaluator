import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { assertRayCapacity } from "../../src/plugins/schedulers/ray/scheduler.js";
import { parseRayConfig } from "../../src/config/ray.js";
import { parseJobsConfig } from "../../src/config/jobs.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { RayClient } from "../../src/infrastructure/ray/client.js";
import { RayJobsDeployment } from "../../src/application/ray/deployment.js";
import { assertJsonValue } from "../../src/core/validation/input.js";

test("Python driver selection excludes ineligible nodes and freezes a capacity-ordered subset", () => {
  expect(() => execFileSync(process.platform === "win32" ? "python" : "python3", [resolve("tests/fixtures/ray-node-selection-tests.py"),
    resolve("src/infrastructure/ray/python/node_selection.py")], { stdio: "pipe", timeout: 10000 })).not.toThrow();
});

test("insufficient capacity fails instead of silently lowering requested concurrency", () => {
  expect(() => assertRayCapacity(24, 25, 50)).toThrow(/24 task slots; 25 required/);
  expect(() => assertRayCapacity(10, 25, 10)).not.toThrow();
  expect(() => assertRayCapacity(25, 25, 50)).not.toThrow();
  expect(() => assertRayCapacity(3, undefined, 50)).not.toThrow();
});

test("Ray Client and Jobs validate the same optional execution-node count", () => {
  const direct = { endpoint: "local", collector: { certFile: "cert.pem", keyFile: "key.pem" } };
  expect(parseRayConfig({ ...direct, nodes: 2 }).nodes).toBe(2);
  expect(parseJobsConfig({ nodes: 2 }).nodes).toBe(2);
  for (const nodes of [0, -1, 1.5, "2"]) {
    expect(() => parseRayConfig({ ...direct, nodes })).toThrow();
    expect(() => parseJobsConfig({ nodes })).toThrow();
  }
});

test.each([2, 4])("Ray Client forwards node count %s and exposes bounded startup diagnostics", async nodes => {
  const directory = await mkdtemp(join(tmpdir(), "ray-selection-wire-"));
  const driverPath = join(directory, "driver.mjs");
  await writeFile(driverPath, `import { createInterface } from "node:readline";
    createInterface({ input: process.stdin }).on("line", line => {
      const input = JSON.parse(line);
      if (input.type === "close") process.exit(0);
      if (input.type !== "start") return;
      if (input.nodes > 3) { process.stdout.write(JSON.stringify({type:"fatal", code:"RayNodeSelectionError", nodeSelection:{requested:input.nodes,available:3}})+"\\n"); return; }
      const nodes = ["a", "b", "c"].slice(0, input.nodes);
      process.stdout.write(JSON.stringify({type:"ready",schemaVersion:2,rayVersion:"2.58.0",pythonVersion:"3.12.14",nodes,slots:nodes.length,nodeSlots:Object.fromEntries(nodes.map(id=>[id,1]))})+"\\n");
    });`);
  const client = new RayClient({ pythonExecutable: process.execPath, driverPath, endpoint: "auto", startupTimeoutMs: 10000, env: process.env, nodes });
  try {
    if (nodes === 2) expect((await client.start(AbortSignal.timeout(10000))).nodes).toEqual(["a", "b"]);
    else await expect(client.start(AbortSignal.timeout(10000))).rejects.toThrow("3 eligible execution nodes; 4 requested");
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Jobs submission preserves nodes and concurrency while projecting connection credentials away", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ray-jobs-selection-"));
  const config = { services: { default: { name: "fixture", endpoint: "https://model.invalid", api: "openai-completions", provider: null } },
    benchmark: { name: "gsm8k", config: {} }, solver: { name: "simpleagent", config: {}, service: "default" },
    environment: { name: "docker", config: {} }, store: { name: "local", config: {} }, reporter: { name: "markdown", config: {} },
    metrics: [], run: { maxTasks: null, taskIds: null, timeoutSeconds: 300 }, output: { directory }, scheduler: { name: "ray", config: {} } };
  const calls: unknown[] = [];
  const client = new JobsClient("https://cluster.invalid", Buffer.alloc(0), "gateway-credential");
  const create = vi.spyOn(JobsClient, "create").mockResolvedValue(client);
  const call = vi.spyOn(client, "call").mockImplementation(async (path, body) => {
    if (path.endsWith("/submit")) { calls.push(body); throw new Error("submission captured"); }
    return {};
  });
  const model = config.services.default;
  const auth = { value: "model-secret", reference: "MODEL_KEY" };
  const scheduler = new RayJobsDeployment(parseJobsConfig({ endpoint: "https://cluster.invalid", caFile: "ca.pem", concurrency: 25, nodes: 2, managedLocal: false }),
    { services: { default: { model, auth } }, solverService: "default", configDirectory: directory, resolvePath: path => join(directory, path) });
  try {
    assertJsonValue(config);
    await expect(scheduler.submitExperiment(config, {}, { signal: AbortSignal.timeout(10000), log: () => {} })).rejects.toThrow("submission captured");
    expect(calls[0]).toMatchObject({ config: { scheduler: { name: "ray", config: { concurrency: 25, nodes: 2 } } } });
  } finally { create.mockRestore(); call.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
