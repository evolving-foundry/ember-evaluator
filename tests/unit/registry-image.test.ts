import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument, parseNetworkSettings } from "../../src/config/network-schema.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { getGlobalDispatcher } from "undici";
import { extract } from "tar";
import { downloadRegistryImage } from "../../src/infrastructure/containers/registry-image.js";
import { dockerRegistryCredential } from "../../src/infrastructure/containers/registry-auth.js";
import { registryProxyFixture } from "../fixtures/registry-proxy.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(wrongDiffId = false) {
  const root = await mkdtemp(join(tmpdir(), "registry-image-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const proxy = await registryProxyFixture(root, wrongDiffId);
  cleanup.push(() => proxy.close());
  const directory = join(root, "download");
  const dockerConfig = join(root, "client");
  await mkdir(dockerConfig);
  await writeFile(join(dockerConfig, "config.json"), "{}");
  vi.stubEnv("DOCKER_CONFIG", dockerConfig);
  return { ...proxy, root, directory, dockerConfig };
}


test.each(["fixture/image:import", "single-name:import"])("downloads verified layers and packs canonical archive tags: %s", async tag => {
  const f = await fixture();
  const dispatcher = getGlobalDispatcher();
  vi.stubEnv("HTTPS_PROXY", "http://wrong.invalid:1");
  const result = await downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, tag, AbortSignal.timeout(5000));
  expect(getGlobalDispatcher()).toBe(dispatcher);
  expect(process.env.HTTPS_PROXY).toBe("http://wrong.invalid:1");
  expect(result).toMatchObject({ sourceDigest: f.indexDigest, configDigest: f.configDigest, manifestDigest: f.manifestDigest });
  const extracted = join(f.root, "archive"); await mkdir(extracted);
  await extract({ file: result.archive, cwd: extracted });
  const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8"));
  expect(manifest[0].RepoTags).toEqual([tag]);
  expect(await readFile(join(extracted, "layer-0.tar"))).toEqual(f.unpacked);
  expect(JSON.parse(await readFile(join(extracted, "index.json"), "utf8")).manifests[0].digest).toBe(f.manifestDigest);
  expect(JSON.parse(await readFile(join(extracted, "index.json"), "utf8")).manifests[0].annotations["io.containerd.image.name"])
    .toBe(`docker.io/${tag.includes("/") ? tag : `library/${tag}`}`);
  expect(f.requests.filter(r => r.path.includes("/manifests/"))).toHaveLength(2);
});

test("authenticates registry bearer requests independently of authenticated proxy access", async () => {
  const f = await fixture(); f.controls.auth = true; f.controls.requireProxyAuth = true;
  await writeFile(join(f.dockerConfig, "config.json"), JSON.stringify({ auths: { "127.0.0.1:9": { auth: Buffer.from("user:password").toString("base64") } } }));
  const proxy = f.proxy.replace("http://", "http://proxy-user:proxy-secret@");
  await downloadRegistryImage(f.reference, "linux/amd64", { http: proxy, https: proxy, noProxy: [] }, f.directory, "fixture/image:auth", AbortSignal.timeout(5000));
  expect(f.requests.find(r => r.path === "/token")?.authorization).toBe(`Basic ${Buffer.from("user:password").toString("base64")}`);
  expect(f.requests.some(r => r.authorization === "Bearer registry-token")).toBe(true);
  expect(f.requests.every(r => r.proxyAuthorization === `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`)).toBe(true);
});

test("retries one layer without downloading completed manifests or config again", async () => {
  const f = await fixture();
  const layer = JSON.parse(f.manifest.toString()).layers[0].digest as string;
  const path = `/v2/example/image/blobs/${layer}`;
  f.controls.transientPath = path; f.controls.transientFailures = 1; f.controls.disconnectLayerOnce = true;
  const image = await downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:retry", AbortSignal.timeout(10000));
  expect(image.configDigest).toBe(f.configDigest);
  expect(f.requests.filter(request => request.path === path)).toHaveLength(3);
  expect(f.requests.filter(request => request.path.includes("/manifests/"))).toHaveLength(2);
  expect(f.requests.filter(request => request.path.endsWith(f.configDigest))).toHaveLength(1);
}, 10000);

test("a transient registry token failure retries without changing credentials or transport", async () => {
  const f = await fixture();
  f.controls.auth = true; f.controls.transientPath = "/token"; f.controls.transientFailures = 1;
  await downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:token-retry", AbortSignal.timeout(10000));
  expect(f.requests.filter(request => request.path === "/token")).toHaveLength(2);
  expect(f.requests.some(request => request.authorization === "Bearer registry-token")).toBe(true);
}, 10000);

test("supports registry basic authentication from Docker credentials", async () => {
  const f = await fixture(); f.controls.basicAuth = true;
  await writeFile(join(f.dockerConfig, "config.json"), JSON.stringify({ auths: { "http://127.0.0.1:9/v1/": { auth: Buffer.from("user:password").toString("base64") } } }));
  await downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:basic", AbortSignal.timeout(5000));
  expect(f.requests.some(r => r.authorization?.startsWith("Basic "))).toBe(true);
});

test("rejects a corrupted layer before Docker import", async () => {
  const f = await fixture(); f.controls.corruptLayer = true;
  await expect(downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toThrow(/layer digest/);
});

test("rejects a manifest which differs from the requested pinned digest", async () => {
  const f = await fixture();
  await expect(downloadRegistryImage(f.reference.replace(f.indexDigest, `sha256:${"f".repeat(64)}`), "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toThrow(/digest/);
});

test("reports registry authentication rejection without exposing proxy credentials", async () => {
  const f = await fixture(); f.controls.auth = true; f.controls.failToken = true;
  await expect(downloadRegistryImage(f.reference, "linux/amd64", parseNetworkSettings({ proxy: { http: f.proxy.replace("http://", "http://user:proxy-secret@") } }).proxy.host, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toThrow("Registry token request failed (HTTP 403)");
});

test("cancels an active layer transfer instead of importing partial content", async () => {
  const f = await fixture(); f.controls.delayLayer = true;
  const controller = new AbortController();
  const work = downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:abort", controller.signal,
    event => { if (event.message?.startsWith("Downloading image layer")) setTimeout(() => controller.abort(new Error("cancelled pull")), 20); });
  await expect(work).rejects.toThrow("cancelled pull");
});

test("does not silently use direct egress when the configured proxy refuses connections", async () => {
  const f = await fixture();
  // Fixed low ports may be silently filtered by the host firewall under WSL.
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Proxy test listener has no TCP address");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  await expect(downloadRegistryImage(f.reference, "linux/amd64", { http: `http://127.0.0.1:${address.port}`, https: null, noProxy: [] }, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: "NETWORK_FAILURE", details: { networkStage: "docker-pull" } });
  expect(f.requests).toHaveLength(0);
});

test("checks uncompressed root filesystem hashes as well as compressed blob hashes", async () => {
  const f = await fixture(true);
  await expect(downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toThrow(/root filesystem digest mismatch/);
});

test("does not forward registry bearer tokens to a redirected blob host", async () => {
  const f = await fixture(); f.controls.auth = true; f.controls.redirectLayer = "http://cdn.invalid/external";
  await downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:redirect", AbortSignal.timeout(5000));
  expect(f.requests.find(r => r.path === "/external")?.authorization).toBeUndefined();
  expect(f.requests.find(r => r.path === "/external")?.host).toBe("cdn.invalid");
});

test("rejects unsafe redirect schemes and wrong-platform image configs", async () => {
  const f = await fixture(); f.controls.redirectLayer = "ftp://cdn.invalid/image";
  await expect(downloadRegistryImage(f.reference, "linux/amd64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:bad", AbortSignal.timeout(5000)))
    .rejects.toThrow(/Unsafe registry redirect/);
  f.controls.redirectLayer = ""; f.controls.useIndex = false;
  await expect(downloadRegistryImage(f.reference.replace(f.indexDigest, f.manifestDigest), "linux/arm64", { http: f.proxy, https: f.proxy, noProxy: [] }, f.directory, "fixture/image:wrong", AbortSignal.timeout(5000)))
    .rejects.toThrow(/platform/);
});

test("reads Docker identity tokens and rejects malformed stored credentials", async () => {
  const f = await fixture();
  await writeFile(join(f.dockerConfig, "config.json"), JSON.stringify({ auths: { "https://index.docker.io/v1/": { identitytoken: "refresh-secret" } } }));
  expect(await dockerRegistryCredential("docker.io", AbortSignal.timeout(5000))).toEqual({ identityToken: "refresh-secret" });
  await writeFile(join(f.dockerConfig, "config.json"), JSON.stringify({ auths: { "registry.test": { auth: Buffer.from("broken").toString("base64") } } }));
  await expect(dockerRegistryCredential("registry.test", AbortSignal.timeout(5000))).rejects.toThrow("Invalid Docker registry credentials");
});
