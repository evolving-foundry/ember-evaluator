import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument, parseNetworkSettings } from "../../src/config/network-schema.js";
import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { createDockerImagePuller } from "../../src/infrastructure/containers/image-pull.js";
import { platformImageCommand } from "../../src/infrastructure/containers/image-inspect.js";
import { resolvePinnedTaskImage } from "../../src/infrastructure/containers/base-image.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { registryProxyFixture } from "../fixtures/registry-proxy.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")("proxy-only registry images import with pinned provenance and remain reusable offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-pull-proxy-smoke-"));
  const f = await registryProxyFixture(root);
  const calls: string[][] = [];
  const command: DockerCommand = platformImageCommand(async (args, options) => {
    calls.push(args);
    if (args[0] === "pull") throw new Error("Proxy acquisition must not call native Docker pull");
    return runDockerCommand("docker", args, options);
  });
  const images = new Set<string>();
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
  const signal = AbortSignal.timeout(45_000);
  try {
    const pull = createDockerImagePuller(command, { network: new NetworkRuntime(networkDocument({ proxy: { http: f.proxy, https: f.proxy }, docker: { pull: { method: "registry-client" } } }, {})) });
    const scope = { taskId: "fixture/proxy-import", phase: "solve" as const };
    const first = await resolvePinnedTaskImage(command, f.reference, "linux/amd64", scope, signal, undefined, pull);
    expect(first).not.toBeNull();
    if (!first) throw new Error("Missing imported image");
    images.add(first.pinnedReference);
    const imported = await pull(f.reference, "linux/amd64", signal);
    images.add(imported.reference);
    expect([f.configDigest, f.manifestDigest]).toContain(first.id);
    expect(imported.verifiedDigest).toBe(f.indexDigest);
    const offline = createDockerImagePuller(command, { network: new NetworkRuntime(networkDocument({ proxy: { http: "http://127.0.0.1:1", https: "http://127.0.0.1:1" }, docker: { pull: { method: "registry-client" } } }, {})) });
    const requestCount = f.requests.length;
    expect(await offline(f.reference, "linux/amd64", signal)).toEqual(imported);
    expect(await resolvePinnedTaskImage(command, f.reference, "linux/amd64", scope, signal, undefined, offline)).toEqual(first);
    expect(f.requests).toHaveLength(requestCount);
    expect(calls.filter(args => args[0] === "load")).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
    await f.close();
    for (const image of images) await command(["image", "rm", "--force", image], { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
