import { afterEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { registryProxyFixture } from "../fixtures/registry-proxy.js";
import { downloadSkopeoImage } from "../../src/infrastructure/containers/skopeo-image.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { networkCommand } from "../../src/infrastructure/network/command.js";

vi.mock("../../src/infrastructure/network/command.js", () => ({ networkCommand: vi.fn() }));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(networkCommand).mockReset(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("skopeo preserves the platform proof and uses the same verified archive builder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skopeo-image-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("DOCKER_CONFIG", join(directory, "no-auth"));
  const source = await registryProxyFixture(directory); cleanup.push(() => source.close());
  const runtime = new NetworkRuntime(networkDocument({ proxy: { https: "http://user:proxy-secret@proxy.test:1" } }, {}));
  cleanup.push(() => runtime.dispose());
  vi.mocked(networkCommand).mockImplementation(async (_executable, args, options) => {
    expect(args.slice(0, 4)).toEqual(["--override-os", "linux", "--override-arch", "amd64"]);
    expect(args.join(" ")).not.toContain("proxy-secret");
    expect(options.env.HTTPS_PROXY).toBe("http://user:proxy-secret@proxy.test:1");
    if (args.includes("inspect")) return { stdout: args.at(-1)!.endsWith(source.manifestDigest) ? source.manifest.toString() : source.index.toString(), stderr: "", exitCode: 0 };
    expect(args).toContain("--preserve-digests");
    const layout = args.at(-1)!.slice(4, -6);
    await mkdir(join(layout, "blobs/sha256"), { recursive: true });
    for (const bytes of [source.manifest, source.config, source.layer])
      await writeFile(join(layout, "blobs/sha256", createHash("sha256").update(bytes).digest("hex")), bytes);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const result = await downloadSkopeoImage(source.reference, "linux/amd64", runtime, "skopeo", join(directory, "download"), "fixture/import:one", AbortSignal.timeout(5000));
  expect(result).toMatchObject({ sourceDigest: source.indexDigest, configDigest: source.configDigest, manifestDigest: source.manifestDigest });
  expect(source.requests).toEqual([]);
  expect(vi.mocked(networkCommand).mock.calls.filter(([, args]) => args.includes("copy"))).toHaveLength(1);
});

test("missing skopeo reports the missing executable without using the Node downloader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skopeo-missing-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("DOCKER_CONFIG", join(directory, "no-auth"));
  vi.mocked(networkCommand).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const runtime = new NetworkRuntime(networkDocument({}, {}));
  await expect(downloadSkopeoImage("busybox:1.37.0", "linux/amd64", runtime, "missing-skopeo", directory, "fixture/import:one", AbortSignal.timeout(5000)))
    .rejects.toThrow("install it yourself or configure skopeoExecutable");
  expect(networkCommand).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});
