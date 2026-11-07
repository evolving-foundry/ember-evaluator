import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument, parseNetworkSettings } from "../../src/config/network-schema.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { pullDockerImage, createDockerImagePuller } from "../../src/infrastructure/containers/image-pull.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { registryProxyFixture } from "../fixtures/registry-proxy.js";
import { resolvePinnedTaskImage } from "../../src/infrastructure/containers/base-image.js";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docker-proxy-pull-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const f = await registryProxyFixture(root);
  cleanup.push(() => f.close());
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
  vi.stubEnv("DOCKER_CONFIG", join(root, "no-credentials"));
  const images = new Map<string, string>();
  const calls: string[][] = [];
  const archives: string[] = [];
  const command: DockerCommand = async args => {
    calls.push(args);
    if (args[0] === "load") {
      const path = args[2]!;
      archives.push(path);
      let manifest = "";
      await list({ file: path, onReadEntry: entry => {
        if (entry.path === "manifest.json") entry.on("data", (chunk: Buffer) => { manifest += chunk.toString(); });
        else entry.resume();
      } });
      const parsed = JSON.parse(manifest) as { RepoTags: string[] }[];
      for (const tag of parsed[0]!.RepoTags) images.set(tag, f.configDigest);
      return { stdout: "loaded", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      const name = args[args.indexOf("--platform") + 2]!;
      const id = images.get(name);
      if (!id) throw new Error("No such image");
      const format = args.at(-1)!;
      if (format.includes("RepoDigests")) return { stdout: JSON.stringify([id, [], "linux", "amd64"]), stderr: "" };
      if (format.includes(".Os")) return { stdout: JSON.stringify([id, "linux", "amd64"]), stderr: "" };
      return { stdout: id, stderr: "" };
    }
    if (args[1] === "tag") { images.set(args[3]!, images.get(args[2]!)!); return { stdout: "", stderr: "" }; }
    if (args[1] === "rm") { images.delete(args.at(-1)!); return { stdout: "", stderr: "" }; }
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
  };
  return { ...f, command, images, calls, archives };
}
test("retries only the pull and reports NETWORK_FAILURE after three failed operations", async () => {
  const failure = new Error("registry connection reset");
  let calls = 0;
  const command: DockerCommand = async () => { calls++; throw failure; };
  await expect(pullDockerImage(command, "image", "linux/amd64", new AbortController().signal)).rejects.toMatchObject({ code: "NETWORK_FAILURE" });
  expect(calls).toBe(3);
});

test("does not start a pull when preparation was cancelled", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  const command: DockerCommand = async () => { calls++; return { stdout: "", stderr: "" }; };
  await expect(pullDockerImage(command, "image", "linux/amd64", controller.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("configured proxy downloads once, imports verified content and reuses persistent receipts without native pull", async () => {
  const f = await fixture();
  const pull = createDockerImagePuller(f.command, { network: new NetworkRuntime(networkDocument({ proxy: { http: f.proxy, https: f.proxy }, docker: { pull: { method: "registry-client" } } }, {})) });
  const [first, shared] = await Promise.all([pull(f.reference, "linux/amd64", AbortSignal.timeout(5000)), pull(f.reference, "linux/amd64", AbortSignal.timeout(5000))]);
  expect(shared).toEqual(first);
  expect(first.verifiedDigest).toBe(f.indexDigest);
  expect(f.calls.filter(args => args[0] === "load")).toHaveLength(1);
  const requests = f.requests.length;
  const fresh = createDockerImagePuller(f.command, { network: new NetworkRuntime(networkDocument({ proxy: { http: "http://127.0.0.1:1", https: "http://127.0.0.1:1" }, docker: { pull: { method: "registry-client" } } }, {})) });
  expect(await fresh(f.reference, "linux/amd64", AbortSignal.timeout(5000))).toEqual(first);
  expect(f.requests).toHaveLength(requests);
  expect(f.calls.some(args => args[0] === "pull")).toBe(false);
  for (const path of f.archives) await expect(readFile(path)).rejects.toThrow();
  f.images.set(first.reference, `sha256:${"f".repeat(64)}`);
  await expect(fresh(f.reference, "linux/amd64", AbortSignal.timeout(5000))).rejects.toThrow(/Cannot acquire/);
});

test("proxy-imported classic images with no RepoDigests retain verified pinned task provenance", async () => {
  const f = await fixture();
  const pull = createDockerImagePuller(f.command, { network: new NetworkRuntime(networkDocument({ proxy: { http: f.proxy, https: f.proxy }, docker: { pull: { method: "registry-client" } } }, {})) });
  const scope = { taskId: "fixture/task", phase: "solve" as const };
  const first = await resolvePinnedTaskImage(f.command, f.reference, "linux/amd64", scope, AbortSignal.timeout(5000), undefined, pull);
  expect(first).toMatchObject({ reference: f.reference, id: f.configDigest });
  const requests = f.requests.length;
  expect(await resolvePinnedTaskImage(f.command, f.reference, "linux/amd64", scope, AbortSignal.timeout(5000), undefined, pull)).toEqual(first);
  expect(f.requests).toHaveLength(requests);
});

test("a corrupt download cannot import content and a later acquisition can recover", async () => {
  const f = await fixture(); f.controls.corruptLayer = true;
  const pull = createDockerImagePuller(f.command, { network: new NetworkRuntime(networkDocument({ proxy: { http: f.proxy, https: f.proxy }, docker: { pull: { method: "registry-client" } } }, {})) });
  await expect(pull(f.reference, "linux/amd64", AbortSignal.timeout(5000))).rejects.toThrow(/Cannot acquire/);
  expect(f.calls.some(args => args[0] === "load")).toBe(false);
  f.controls.corruptLayer = false;
  expect((await pull(f.reference, "linux/amd64", AbortSignal.timeout(5000))).verifiedDigest).toBe(f.indexDigest);
});

test("Node runtime accepts a verified imported config ID without requiring registry RepoDigests", async () => {
  let ref = "";
  const id = `sha256:${"b".repeat(64)}`;
  const command: DockerCommand = async args => {
    if (args[0] === "info") return { stdout: "[]", stderr: "" };
    if (args.includes("imported:node")) return { stdout: `${id} []`, stderr: "" };
    throw new Error("No such image");
  };
  const runtime = new DockerRuntime(command, PINNED_NODE_IMAGE, "linux/amd64", async reference => {
    ref = reference;
    return { reference: "imported:node", verifiedDigest: PINNED_NODE_IMAGE.split("@")[1]! };
  });
  expect(await runtime.nodeImageDigest(AbortSignal.timeout(5000))).toBe(id);
  expect(ref).toBe(PINNED_NODE_IMAGE);
  expect(runtime.nodeImage).toBe("imported:node");
});
