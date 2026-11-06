import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DockerImageInventory } from "../../src/infrastructure/containers/image-inventory.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { fingerprintImageConfig } from "../../src/core/policies/image-config.js";
import { parseImageCleanupRequest, parseImageCleanupSummary } from "../../src/infrastructure/ray/image-cleanup.js";

const id = `sha256:${"a".repeat(64)}`, otherId = `sha256:${"b".repeat(64)}`;
const source = "official/task:v1", base = "ember-evaluator/task:solve-base-a", agent = "ember-evaluator/task:solve-agent-a";
const signal = () => AbortSignal.timeout(10_000);
const owner = (configFingerprint = "a".repeat(64)) => ({ configFingerprint, taskId: "task", phase: "solve" });
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "image-cleanup-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function docker(daemonId = "fixture-daemon") {
  const images = new Map<string, string>();
  const containers = new Map<string, string>();
  const calls: string[][] = [];
  const fail = new Set<string>();
  const command: DockerCommand = async (args, options) => {
    options?.signal?.throwIfAborted(); calls.push([...args]);
    const result = (stdout = "") => ({ stdout, stderr: "" });
    if (args[0] === "info") return result(daemonId);
    if (args[0] === "ps") return result([...containers.keys()].join("\n"));
    if (args[0] === "container" && args[1] === "inspect") return result(containers.get(args[2]!)!);
    if (args[0] === "pull") { images.set(args.at(-1)!, id); return result(); }
    if (args[0] === "build") { images.set(args[args.indexOf("--tag") + 1]!, otherId); return result(); }
    if (args[0] === "image" && args[1] === "tag") { images.set(args[3]!, images.get(args[2]!)!); return result(); }
    if (args[0] === "image" && args[1] === "inspect") {
      const reference = args[2]!, found = images.get(reference) ?? [...images.values()].find(image => image === reference);
      if (!found) throw new Error(`No such image: ${reference}`);
      return result(args.at(-1)!.includes("RepoTags") ? JSON.stringify([found, [...images].filter(([, image]) => image === found).map(([tag]) => tag), []]) : found);
    }
    if (args[0] === "image" && args[1] === "ls") return result([...images.keys()].map(reference => {
      const separator = reference.lastIndexOf(":");
      return JSON.stringify({ Repository: reference.slice(0, separator), Tag: reference.slice(separator + 1), ID: images.get(reference) });
    }).join("\n"));
    if (args[0] === "image" && args[1] === "rm") {
      if (fail.has(args.at(-1)!)) throw new Error("Docker removal failed");
      images.delete(args.at(-1)!); return result();
    }
    throw new Error(`Unexpected Docker command ${args.join(" ")}`);
  };
  return { images, containers, calls, fail, inventory: new DockerImageInventory(command, directory), command };
}

async function acquire(fake: ReturnType<typeof docker>, existing = false, config = owner()) {
  if (existing) fake.images.set(source, id);
  await fake.inventory.use(config, signal(), async () => {
    if (!existing) await fake.inventory.command(["pull", source], { signal: signal() });
    else await fake.inventory.command(["image", "inspect", source, "--format", "{{.Id}}"], { signal: signal() });
    await fake.inventory.command(["image", "tag", source, base], { signal: signal() });
  });
}
const selected = (execute = true, configFingerprint = owner().configFingerprint) => ({ all: false, execute, configFingerprint });

test("preview lists downloaded and derived references without modifying the receipt or removing images", async () => {
  const fake = docker(); await acquire(fake);
  const file = (await readdir(directory)).find(file => file.endsWith(".json"))!;
  const before = await readFile(join(directory, file), "utf8");
  const result = await fake.inventory.cleanup(selected(false), signal());
  expect(result.items.map(item => item.status)).toEqual(["candidate", "candidate"]);
  expect(await readFile(join(directory, file), "utf8")).toBe(before);
  expect(fake.images.size).toBe(2);
  expect(fake.calls.some(args => args[1] === "rm")).toBe(false);
});

test("cleanup deletes actually acquired sources and evaluator aliases; repeated cleanup is empty", async () => {
  const fake = docker(); await acquire(fake);
  expect((await fake.inventory.cleanup(selected(), signal())).items.every(item => item.status === "deleted")).toBe(true);
  expect(fake.images.size).toBe(0);
  expect((await fake.inventory.cleanup(selected(), signal())).items).toEqual([]);
  expect(fake.calls.filter(args => args[1] === "rm").every(args => args.includes("--no-prune") && !args.includes("--force"))).toBe(true);
});

test("sources which existed before evaluation remain even when evaluator aliases are deleted", async () => {
  const fake = docker(); await acquire(fake, true);
  const result = await fake.inventory.cleanup(selected(), signal());
  expect(result.items.find(item => item.reference === source)?.status).toBe("retained");
  expect(fake.images.has(source)).toBe(true); expect(fake.images.has(base)).toBe(false);
});
test("preserving a preexisting source does not leave obsolete configuration ownership", async () => {
  const fake = docker(); await acquire(fake, true);
  await fake.inventory.cleanup(selected(), signal());
  await acquire(fake, true, owner("b".repeat(64)));
  const result = await fake.inventory.cleanup(selected(true, "b".repeat(64)), signal());
  expect(result.items.find(item => item.reference === base)?.status).toBe("deleted");
  expect(fake.images.has(source)).toBe(true);
  expect((await fake.inventory.cleanup(selected(), signal())).items).toEqual([]);
});

test("a shared image survives until its last selected configuration is removed", async () => {
  const fake = docker(); await acquire(fake);
  await fake.inventory.use(owner("b".repeat(64)), signal(), () => fake.inventory.command(["image", "inspect", base, "--format", "{{.Id}}"], { signal: signal() }));
  expect((await fake.inventory.cleanup(selected(), signal())).items.every(item => item.status === "retained")).toBe(true);
  expect(fake.images.size).toBe(2);
  expect((await fake.inventory.cleanup(selected(true, "b".repeat(64)), signal())).items.every(item => item.status === "deleted")).toBe(true);
});

test("both running and stopped container references prevent image removal", async () => {
  const fake = docker(); await acquire(fake);
  fake.containers.set("c".repeat(64), id);
  expect((await fake.inventory.cleanup(selected(), signal())).items.every(item => item.status === "skipped" && item.reason.includes("container"))).toBe(true);
  expect(fake.images.size).toBe(2);
});

test("an active evaluator lease blocks cleanup until released", async () => {
  const fake = docker(); await acquire(fake);
  const release = await fake.inventory.lease(signal());
  fake.containers.set("c".repeat(64), id);
  const before = fake.calls.length;
  expect((await fake.inventory.cleanup(selected(), signal())).items.every(item => item.status === "skipped")).toBe(true);
  expect(fake.calls.slice(before).some(args => args[0] === "container" && args[1] === "inspect")).toBe(false);
  await release();
  fake.containers.clear();
  expect((await fake.inventory.cleanup(selected(), signal())).items.every(item => item.status === "deleted")).toBe(true);
});

test("a reference moved to another image is skipped instead of deleting the new image", async () => {
  const fake = docker(); await acquire(fake);
  fake.images.set(base, otherId);
  const result = await fake.inventory.cleanup(selected(), signal());
  expect(result.items.find(item => item.reference === base)).toMatchObject({ status: "skipped", reason: expect.stringContaining("changed") });
  expect(fake.images.get(base)).toBe(otherId);
});
test("a digest with a foreign tag is retained rather than removing that user's tag", async () => {
  const fake = docker();
  const reference = `official/task@${id}`;
  await fake.inventory.use(owner(), signal(), () => fake.inventory.command(["pull", reference], { signal: signal() }));
  fake.images.set("user/keep:latest", id);
  expect((await fake.inventory.cleanup(selected(), signal())).items).toEqual([expect.objectContaining({ reference, status: "retained" })]);
  expect(fake.images.has("user/keep:latest")).toBe(true);
});

test("--all admits historical evaluator names but preserves unrecorded foreign images", async () => {
  const fake = docker(); fake.images.set(base, id); fake.images.set(source, id);
  const result = await fake.inventory.cleanup({ all: true, execute: true }, signal());
  expect(result.items).toEqual([expect.objectContaining({ reference: base, status: "deleted" })]);
  expect(fake.images.has(source)).toBe(true);
});
test("first previews on a shared cache agree on inventory identity without recording image associations", async () => {
  const a = docker("shared-daemon"), b = docker("shared-daemon");
  a.images.set(base, id); b.images.set(base, id);
  const first = await a.inventory.cleanup({ all: true, execute: false }, signal());
  const second = await b.inventory.cleanup({ all: true, execute: false }, signal());
  expect(first.inventoryId).toBe(second.inventoryId);
  const file = (await readdir(directory)).find(file => file.endsWith(".json"))!;
  expect(JSON.parse(await readFile(join(directory, file), "utf8")).entries).toEqual([]);
  expect(a.images.has(base)).toBe(true); expect(b.images.has(base)).toBe(true);
});
test("all-image preview uses one Docker inventory query instead of inspecting hundreds of aliases", async () => {
  const fake = docker();
  for (let index = 0; index < 200; index++) fake.images.set(`ember-evaluator/task-${index}:runtime`, id);
  const result = await fake.inventory.cleanup({ all: true, execute: false }, signal());
  expect(result.items).toHaveLength(200);
  expect(result.items.every(item => item.status === "candidate")).toBe(true);
  expect(fake.calls.filter(args => args[0] === "image" && args[1] === "ls")).toHaveLength(1);
  expect(fake.calls.some(args => args[0] === "image" && args[1] === "inspect")).toBe(false);
});

test("a failed deletion does not prevent other references from being processed", async () => {
  const fake = docker(); await acquire(fake); fake.fail.add(source);
  const result = await fake.inventory.cleanup(selected(), signal());
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ reference: source, status: "failed" }), expect.objectContaining({ reference: base, status: "deleted" })]));
});
test("cancellation preserves completed deletion results and skips subsequent references", async () => {
  const fake = docker(); await acquire(fake);
  const controller = new AbortController();
  const inventory = new DockerImageInventory(async (args, options) => {
    const result = await fake.command(args, options);
    if (args[0] === "image" && args[1] === "rm") controller.abort();
    return result;
  }, directory);
  const result = await inventory.cleanup(selected(), controller.signal);
  expect(result.items.filter(item => item.status === "deleted")).toHaveLength(1);
  expect(result.items.filter(item => item.status === "skipped" && item.reason.includes("cancelled"))).toHaveLength(1);
  expect(fake.images.size).toBe(1);
});

test("inventory records are separated by Docker daemon identity", async () => {
  const a = docker("daemon-a"), b = docker("daemon-b"); await acquire(a);
  b.images.set(base, id);
  expect((await b.inventory.cleanup(selected(), signal())).items).toEqual([]);
  expect(b.images.has(base)).toBe(true);
});

test("derived images are removed before shared inputs; cached use records transitive owners", async () => {
  const fake = docker(); await acquire(fake);
  await writeFile(join(directory, "Dockerfile"), `FROM ${base}\n`);
  await fake.inventory.use(owner(), signal(), () => fake.inventory.command(["build", "--tag", agent, directory], { signal: signal() }));
  const result = await fake.inventory.cleanup(selected(), signal());
  expect(result.items[0]).toMatchObject({ reference: agent, status: "deleted" });
  expect(fake.images.size).toBe(0);
});

test("configuration ownership ignores scheduling, outputs, credentials and declared node-local fields", () => {
  const config = { benchmark: { name: "tasks", config: { cacheDir: "local-a", source: "test", token: "secret" } }, solver: { name: "solver", config: {} }, output: "a", services: { key: "secret" } };
  const lookup = () => ({ nodeLocal: { cacheDir: "cache" as const }, secretFields: ["token"] });
  expect(fingerprintImageConfig(config, lookup)).toBe(fingerprintImageConfig({ ...config, output: "b", services: {}, benchmark: { ...config.benchmark, config: { ...config.benchmark.config, cacheDir: "local-b", token: "other" } } }, lookup));
});
test("different task selections keep distinct shared-image associations", () => {
  const config = { benchmark: { name: "tasks", config: {} }, run: { taskIds: ["task-a"] } };
  expect(fingerprintImageConfig(config)).not.toBe(fingerprintImageConfig({ ...config, run: { taskIds: ["task-b"] } }));
});

test("cleanup protocol rejects invalid selectors and impossible preview deletion reports", () => {
  expect(() => parseImageCleanupRequest({ all: false, execute: false })).toThrow();
  expect(() => parseImageCleanupSummary({ preview: true, nodes: [{ nodeId: "a", daemonId: "d", items: [{ reference: base, imageId: id, status: "deleted", reason: "test" }] }] })).toThrow();
});
