import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { DockerComposeProject } from "../../src/infrastructure/containers/compose.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";

vi.mock("../../src/infrastructure/containers/command.js", () => ({ runDockerCommand: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test.each([false, true])("Compose preparation releases its gateway even when project cleanup fails: %s", async cleanupFails => {
  const root = await mkdtemp(join(tmpdir(), "docker-preparation-cleanup-"));
  vi.stubEnv("EVALUATOR_CACHE_DIR", join(root, "cache"));
  const gatewayId = "a".repeat(64);
  const digest = "sha256:" + "b".repeat(64);
  const calls: string[][] = [];
  vi.mocked(runDockerCommand).mockImplementation(async (_executable, args) => {
    calls.push(args);
    let stdout = "";
    if (args[0] === "version") stdout = args.at(-1)?.includes("APIVersion") ? "1.49 1.49" : "linux/amd64";
    else if (args[0] === "info") stdout = "fixture-daemon";
    else if (args[0] === "image") stdout = args.at(-1)?.includes("RepoTags") ? JSON.stringify([digest, [], []]) : digest;
    else if (args[0] === "create") stdout = gatewayId;
    return { stdout, stderr: "" };
  });
  const primary = new Error("fixture Compose startup failure");
  const cleanup = new Error("fixture Compose cleanup failure");
  vi.spyOn(DockerComposeProject.prototype, "create").mockRejectedValue(primary);
  vi.spyOn(DockerComposeProject.prototype, "dispose").mockImplementation(async () => {
    if (cleanupFails) throw cleanup;
  });
  const spec: EnvironmentSpec = {
    workdir: "/workspace", image: "fixture/base", initialFiles: [], runtime: [], network: "model-api",
    services: { main: { image: null, properties: {} } },
    prepared: {
      kind: "docker", platform: "linux/amd64", launchImage: digest, gatewayImage: digest, gatewayDigest: digest,
      baseImage: { reference: "fixture/base", pinnedReference: digest, id: digest },
      runtime: { image: digest, digest }, solverImage: null, serviceImages: {},
    },
  };
  try {
    const result = new DockerEnvironment({ modelEndpoint: "https://model.example.test/v1" }).prepare(spec,
      { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
      "solve", AbortSignal.timeout(5_000));
    if (cleanupFails) await expect(result).rejects.toMatchObject({
      code: "CLEANUP_FAILED", cause: expect.objectContaining({ errors: [primary, cleanup] }),
    });
    else await expect(result).rejects.toBe(primary);
    const volume = calls.find(args => args[0] === "volume" && args[1] === "create")?.at(-1);
    expect(volume).toBeTypeOf("string");
    expect(calls).toContainEqual(["rm", "--force", gatewayId]);
    expect(calls.at(-1)).toEqual(["volume", "rm", "--force", volume]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
