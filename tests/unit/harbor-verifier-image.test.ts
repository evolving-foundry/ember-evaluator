import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dockerBuildNetwork } from "../../src/infrastructure/containers/build-network.js";
import { createPythonVerifierImage } from "../../src/plugins/verifiers/python/runtime/image.js";
import { withDockerActivity } from "../../src/infrastructure/containers/progress.js";

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "verifier-image-test-"));
  vi.stubEnv("EVALUATOR_CACHE_DIR", cache);
});
afterEach(async () => {
  // Cancelled callers may return before the shared operation releases its file lock.
  await vi.waitFor(async () => {
    const files = await readdir(join(cache, "image-builds")).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(files).toEqual([]);
  });
  vi.unstubAllEnvs();
  await rm(cache, { recursive: true, force: true });
});

function imageFixture() {
  let present = false;
  const started = Promise.withResolvers<AbortSignal>();
  const gate = Promise.withResolvers<void>();
  const command = vi.fn(async (args: string[], signal: AbortSignal) => {
    if (args[0] === "image") {
      if (!present) throw new Error("No such image");
      return;
    }
    started.resolve(signal);
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await Promise.race([gate.promise, cancelled.promise]);
      present = true;
    } finally { signal.removeEventListener("abort", abort); }
  });
  return { image: createPythonVerifierImage("fixture", command), command, started, gate, remove: () => { present = false; } };
}
test("build configuration keeps location-specific proxy routes explicit", () => {
  const access = new NetworkRuntime(networkDocument({ proxy: { https: "http://127.0.0.1:7890", overrides: { build: { https: "http://host.docker.internal:7890" } } }, sources: { python: { index: "https://python.example/simple" } }, docker: { buildNetwork: "host" } }, {}));
  const network = dockerBuildNetwork(access);
  expect(network.identity.sources.python.index).toBe("https://python.example/simple");
  expect(network.identity.proxy.https).toBe("http://host.docker.internal:7890");
  const networkFlag = network.buildArgs.indexOf("--network");
  expect(networkFlag).toBeGreaterThanOrEqual(0);
  expect(network.buildArgs[networkFlag + 1]).toBe("host");
});
test("the verifier build forwards mirrors and proxy settings without model credentials", async () => {
  vi.stubEnv("EVALUATOR_DEBIAN_MIRROR", "https://debian.example");
  vi.stubEnv("PIP_INDEX_URL", "https://python.example/simple"); vi.stubEnv("UV_DEFAULT_INDEX", ""); vi.stubEnv("UV_INDEX_URL", "");
  vi.stubEnv("EVALUATOR_GITHUB_MIRROR", "https://git.example/https://github.com/");
  vi.stubEnv("JUDGE_MODEL_API_KEY", "must-not-be-sent");
  const calls: string[][] = [];
  const image = createPythonVerifierImage("fixture-docker", async args => { calls.push(args); if (args[0] === "image") throw new Error("No such image"); });
  const tag = await image(new AbortController().signal);
  expect(tag).toMatch(/^ember-harbor-verifier:[a-f0-9]{24}$/u);
  expect(calls[1]).toEqual(expect.arrayContaining(["PIP_INDEX_URL=https://python.example/simple", "EVALUATOR_GITHUB_MIRROR=https://git.example/https://github.com"]));
  expect(JSON.stringify(calls)).not.toContain("must-not-be-sent");
});
test("changing a mirror invalidates the image cache and cached images avoid rebuilding", async () => {
  vi.stubEnv("UV_DEFAULT_INDEX", ""); vi.stubEnv("UV_INDEX_URL", "");
  const command = vi.fn(async () => undefined);
  const image = createPythonVerifierImage("fixture", command);
  vi.stubEnv("PIP_INDEX_URL", "https://first.example/simple");
  const first = await image(new AbortController().signal);
  vi.stubEnv("PIP_INDEX_URL", "https://second.example/simple");
  const second = await image(new AbortController().signal);
  expect(first).not.toBe(second); expect(command.mock.calls).toHaveLength(2);
});
test("cancellation during image lookup never starts a build", async () => {
  const cancel = new AbortController(); const calls: string[][] = [];
  const image = createPythonVerifierImage("fixture", async args => { calls.push(args); cancel.abort(new Error("cancelled lookup")); throw new Error("lookup failed"); });
  await expect(image(cancel.signal)).rejects.toThrow("cancelled lookup");
  expect(calls).toHaveLength(1);
});

test("four preparation workers share one build and later calls inspect Docker again", async () => {
  const f = imageFixture();
  const joined = Promise.withResolvers<void>();
  let waiting = 0;
  const jobs = Array.from({ length: 4 }, () => withDockerActivity(event => {
    if (event.message === "Waiting for a shared image build" && ++waiting === 3) joined.resolve();
  }, () => f.image(AbortSignal.timeout(5000))));
  await joined.promise;
  await f.started.promise;
  f.gate.resolve();
  const tags = await Promise.all(jobs);
  expect(new Set(tags).size).toBe(1);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(1);
  await f.image(AbortSignal.timeout(5000));
  expect(f.command.mock.calls.filter(([args]) => args[0] === "image")).toHaveLength(2);
  f.remove();
  await f.image(AbortSignal.timeout(5000));
  expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(2);
});

test("cancelling the first waiter leaves the build running for another task", async () => {
  const f = imageFixture();
  const controller = new AbortController();
  const first = f.image(controller.signal);
  const active = await f.started.promise;
  const joined = Promise.withResolvers<void>();
  const second = withDockerActivity(event => {
    if (event.message === "Waiting for a shared image build") joined.resolve();
  }, () => f.image(AbortSignal.timeout(5000)));
  await joined.promise;
  const cancelled = expect(first).rejects.toThrow("task stopped");
  controller.abort(new Error("task stopped"));
  await cancelled;
  expect(active.aborted).toBe(false);
  f.gate.resolve();
  await expect(second).resolves.toMatch(/^ember-harbor-verifier:/u);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(1);
});

test("cancelling every waiter stops the build and a later call can retry", async () => {
  const f = imageFixture();
  const controller = new AbortController();
  const peer = new AbortController();
  const pending = f.image(controller.signal);
  const active = await f.started.promise;
  const joined = Promise.withResolvers<void>();
  const second = withDockerActivity(event => {
    if (event.message === "Waiting for a shared image build") joined.resolve();
  }, () => f.image(peer.signal));
  await joined.promise;
  const cancelled = expect(pending).rejects.toThrow("task stopped");
  controller.abort(new Error("task stopped"));
  await cancelled;
  expect(active.aborted).toBe(false);
  const peerCancelled = expect(second).rejects.toThrow("peer stopped");
  peer.abort(new Error("peer stopped"));
  await peerCancelled;
  expect(active.aborted).toBe(true);
  f.gate.resolve();
  await expect(f.image(AbortSignal.timeout(5000))).resolves.toMatch(/^ember-harbor-verifier:/u);
  expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(2);
});

test.each(["DOCKER_HOST", "DOCKER_CONTEXT"])("different %s targets do not share a build or lock", async variable => {
  const f = imageFixture();
  vi.stubEnv(variable, "first-target");
  const first = f.image(AbortSignal.timeout(5000));
  await f.started.promise;
  vi.stubEnv(variable, "second-target");
  const second = f.image(AbortSignal.timeout(5000));
  await vi.waitFor(() => expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(2));
  f.gate.resolve();
  const tags = await Promise.all([first, second]);
  expect(tags[0]).toBe(tags[1]);
});

test("cancelling a file-lock waiter leaves the owner's build running", async () => {
  const f = imageFixture();
  const first = f.image(AbortSignal.timeout(5000));
  const active = await f.started.promise;
  const other = createPythonVerifierImage("fixture", f.command);
  const controller = new AbortController();
  const second = other(controller.signal);
  await vi.waitFor(async () => {
    expect((await readdir(join(cache, "image-builds"))).filter(file => file.endsWith(".tmp"))).toHaveLength(1);
  });
  const cancelled = expect(second).rejects.toThrow("wait stopped");
  controller.abort(new Error("wait stopped"));
  await cancelled;
  expect(active.aborted).toBe(false);
  f.gate.resolve();
  await first;
  expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(1);
});

test("an already cancelled task never inspects or builds an image", async () => {
  const f = imageFixture();
  await expect(f.image(AbortSignal.abort(new Error("task stopped")))).rejects.toThrow("task stopped");
  expect(f.command).not.toHaveBeenCalled();
});

test("failed builds release the lock and can be retried", async () => {
  let builds = 0;
  const image = createPythonVerifierImage("fixture", async args => {
    if (args[0] === "image") throw new Error("No such image");
    if (++builds === 1) throw new Error("build failed");
  });
  await expect(image(AbortSignal.timeout(5000))).rejects.toThrow("build failed");
  await expect(image(AbortSignal.timeout(5000))).resolves.toMatch(/^ember-harbor-verifier:/u);
  expect(builds).toBe(2);
});

test("different image tags can build concurrently", async () => {
  vi.stubEnv("UV_DEFAULT_INDEX", ""); vi.stubEnv("UV_INDEX_URL", "");
  const f = imageFixture();
  vi.stubEnv("PIP_INDEX_URL", "https://first.example/simple");
  const first = f.image(AbortSignal.timeout(5000));
  await f.started.promise;
  vi.stubEnv("PIP_INDEX_URL", "https://second.example/simple");
  const second = f.image(AbortSignal.timeout(5000));
  await vi.waitFor(() => expect(f.command.mock.calls.filter(([args]) => args[0] === "build")).toHaveLength(2));
  f.gate.resolve();
  const tags = await Promise.all([first, second]);
  expect(tags[0]).not.toBe(tags[1]);
});

test("Docker connection errors are propagated without attempting a build", async () => {
  const failure = new Error("Cannot connect to the Docker daemon");
  const command = vi.fn(async () => { throw failure; });
  const image = createPythonVerifierImage("fixture", command);
  await expect(image(AbortSignal.timeout(5000))).rejects.toBe(failure);
  expect(command).toHaveBeenCalledTimes(1);
});


const pythonExecutable = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(pythonExecutable, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"], { timeout: 5000, windowsHide: true }).status === 0;
test.skipIf(!pythonAvailable)("upstream checkout retries and frozen install preserve source and dependency pins", async () => {
  const result = await promisify(execFile)(pythonExecutable, [resolve("tests/fixtures/harbor-verifier-build-tests.py"), resolve("src/plugins/verifiers/python/runtime/build-runtime.py")], { timeout: 10000, windowsHide: true });
  expect(result.stderr).toContain("Ran 7 tests"); expect(result.stderr).toContain("OK");
});
