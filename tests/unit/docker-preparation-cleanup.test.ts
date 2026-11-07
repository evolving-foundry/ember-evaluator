import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { DockerComposeProject } from "../../src/infrastructure/containers/compose.js";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";

vi.mock("../../src/infrastructure/containers/command.js", () => ({ runDockerCommand: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docker-preparation-cleanup-"));
  const cache = join(root, "cache");
  vi.stubEnv("EVALUATOR_CACHE_DIR", cache);
  const daemon = "fixture-daemon";
  const inventory = join(cache, "docker-images", `${createHash("sha256").update(daemon).digest("hex")}.json`);
  const id = "a".repeat(64);
  const digest = "sha256:" + "b".repeat(64);
  const calls: string[][] = [];
  vi.mocked(runDockerCommand).mockImplementation(async (_executable, args) => {
    calls.push(args);
    let stdout = "";
    const format = args.at(-1);
    if (args[0] === "version") stdout = format?.includes("APIVersion") ? "1.49 1.49" : "linux/amd64";
    else if (args[0] === "info") stdout = daemon;
    else if (args[0] === "image" && args[1] === "inspect") {
      if (format?.includes("RepoTags")) stdout = JSON.stringify([digest, [], []]);
      else stdout = format === "{{.Os}}/{{.Architecture}}" ? "linux/amd64" : digest;
    }
    else if (args[0] === "create") stdout = id;
    else if (args[0] === "inspect") stdout = "[]";
    else if (args[0] === "exec" && args.includes("process.stdout.write(process.platform + '/' + process.arch)")) stdout = "linux/x64";
    else if (args[0] === "exec" && args[7]?.includes("const owners = []")) {
      const mounts = JSON.parse(args[8]!) as string[];
      stdout = JSON.stringify(mounts.map(path => ({ path, uid: 1000, gid: 1000, mode: 0o700 })));
    }
    return { stdout, stderr: "" };
  });
  const spec: EnvironmentSpec = { workdir: "/workspace", image: "fixture/base", initialFiles: [], runtime: [] };
  const runtime = { image: "fixture/runtime", digest, baseDigest: digest, runtimes: [] };
  const prepared = { kind: "docker", platform: "linux/amd64", launchImage: digest, gatewayImage: null, gatewayDigest: null,
    baseImage: { reference: "fixture/base", pinnedReference: digest, id: digest }, runtime, solverImage: null, serviceImages: {} };
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const leaseCount = async () => (JSON.parse(await readFile(inventory, "utf8")) as { leases: unknown[] }).leases.length;
  return { root, paths, calls, id, digest, spec, runtime, prepared, leaseCount };
}

test.each([false, true])("Compose preparation releases its gateway even when project cleanup fails: %s", async cleanupFails => {
  const { root, paths, calls, id, digest, spec, prepared, leaseCount } = await fixture();
  const primary = new Error("fixture Compose startup failure");
  const cleanup = new Error("fixture Compose cleanup failure");
  vi.spyOn(DockerComposeProject.prototype, "create").mockRejectedValue(primary);
  vi.spyOn(DockerComposeProject.prototype, "dispose").mockImplementation(async () => {
    expect(await leaseCount()).toBe(1);
    if (cleanupFails) throw cleanup;
  });
  try {
    const result = new DockerEnvironment({ modelEndpoint: "https://model.example.test/v1" }).prepare({ ...spec,
      network: "model-api", services: { main: { image: null, properties: {} } },
      prepared: { ...prepared, gatewayImage: digest, gatewayDigest: digest },
    }, paths, "solve", AbortSignal.timeout(5_000));
    if (cleanupFails) await expect(result).rejects.toMatchObject({
      code: "CLEANUP_FAILED", cause: expect.objectContaining({ errors: [primary, cleanup] }),
    });
    else await expect(result).rejects.toBe(primary);
    const volume = calls.find(args => args[0] === "volume" && args[1] === "create")?.at(-1);
    expect(volume).toBeTypeOf("string");
    expect(calls).toContainEqual(["rm", "--force", id]);
    expect(calls.at(-1)).toEqual(["volume", "rm", "--force", volume]);
    expect(await leaseCount()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([false, true])("standalone launch uses a resolved image and transfers one lease to the session, receipt=%s", async hasReceipt => {
  const { root, paths, calls, id, digest, spec, runtime, prepared, leaseCount } = await fixture();
  const build = vi.spyOn(DockerRuntime.prototype, "prepare").mockResolvedValue(runtime);
  const signal = AbortSignal.timeout(5_000);
  try {
    const session = await new DockerEnvironment().prepare(hasReceipt ? { ...spec, prepared } : spec, paths, "solve", signal);
    try {
      expect(build).toHaveBeenCalledTimes(hasReceipt ? 0 : 1);
      expect(calls.find(args => args[0] === "create")).toEqual(expect.arrayContaining(["--pull", "never", digest]));
      expect(calls.some(args => args[0] === "pull" || args[0] === "build")).toBe(false);
      expect(await leaseCount()).toBe(1);
    } finally { await Promise.all([session.dispose(signal), session.dispose(signal)]); }
    expect(calls.filter(args => args[0] === "rm" && args.includes(id))).toHaveLength(1);
    expect(await leaseCount()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("on-demand Compose resolves sidecar images without calling public materialize", async () => {
  const { root, paths, digest, spec, runtime, leaseCount } = await fixture();
  vi.spyOn(DockerRuntime.prototype, "prepare").mockResolvedValue(runtime);
  const environment = new DockerEnvironment();
  const materialize = vi.spyOn(environment, "materialize");
  const failure = new Error("Compose stopped before creating containers");
  const launch = vi.spyOn(DockerComposeProject.prototype, "create").mockImplementation(async (_main, images) => {
    expect(images).toEqual({ api: digest });
    expect(await leaseCount()).toBe(1);
    throw failure;
  });
  vi.spyOn(DockerComposeProject.prototype, "dispose").mockResolvedValue();
  try {
    await expect(environment.prepare({ ...spec, services: { api: { image: "fixture/api", properties: {} } } },
      paths, "solve", AbortSignal.timeout(5_000))).rejects.toBe(failure);
    expect(launch).toHaveBeenCalledOnce();
    expect(materialize).not.toHaveBeenCalled();
    expect(await leaseCount()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing prepared sidecar fails before Compose starts or Docker pulls an image", async () => {
  const { root, paths, calls, spec, prepared, leaseCount } = await fixture();
  try {
    await expect(new DockerEnvironment().prepare({ ...spec, prepared, services: { api: { image: "fixture/api", properties: {} } } },
      paths, "solve", AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "ENV_PREPARED_IMAGE_LOST" });
    expect(calls.some(args => ["compose", "create", "pull", "build"].includes(args[0]!))).toBe(false);
    expect(await leaseCount()).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
