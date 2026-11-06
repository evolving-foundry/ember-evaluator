import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DockerBuildCache } from "../../src/infrastructure/containers/build-cache.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "image-build-lock-"));
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
});
afterEach(async () => {
  await vi.waitFor(async () => expect(await readdir(join(root, "image-builds"))).toEqual([]));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("cancelling another instance's lock waiter leaves the active build running", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const gate = Promise.withResolvers<void>();
  const first = new DockerBuildCache<string>().getImage("docker", "fixture:task", AbortSignal.timeout(5000), async active => {
    started.resolve(active);
    await gate.promise;
    active.throwIfAborted();
    return "ready";
  });
  const active = await started.promise;
  const cancel = new AbortController();
  const build = vi.fn(async () => "unexpected");
  const second = new DockerBuildCache<string>().getImage("docker", "fixture:task", cancel.signal, build);
  try {
    await vi.waitFor(async () => expect((await readdir(join(root, "image-builds"))).filter(path => path.endsWith(".tmp"))).toHaveLength(1));
    cancel.abort(new Error("cancelled waiter"));
    await expect(second).rejects.toThrow("cancelled waiter");
    expect(active.aborted).toBe(false);
    expect(build).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    await first;
  }
});

test.each([["docker", "fixture:other"], ["other-docker", "fixture:task"]])("different image or Docker target remains concurrent: %s %s", async (docker, image) => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const first = new DockerBuildCache<string>().getImage("docker", "fixture:task", AbortSignal.timeout(5000), async () => {
    started.resolve();
    await gate.promise;
    return "first";
  });
  await started.promise;
  try {
    await expect(new DockerBuildCache<string>().getImage(docker, image, AbortSignal.timeout(2000), async () => "second")).resolves.toBe("second");
  } finally { gate.resolve(); await first; }
});

test("a failed build releases the lock so another instance can retry", async () => {
  const signal = AbortSignal.timeout(5000);
  await expect(new DockerBuildCache<string>().getImage("docker", "fixture:task", signal, async () => { throw new Error("build failed"); })).rejects.toThrow("build failed");
  await expect(new DockerBuildCache<string>().getImage("docker", "fixture:task", signal, async () => "recovered")).resolves.toBe("recovered");
});
