import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getGlobalDispatcher } from "undici";
import { defaultNetworkConfigPath, loadNetworkConfig } from "../../src/config/network.js";
import { networkDocument, networkSnapshot, parseNetworkSettings, redactNetwork, restoreNetworkTemplate } from "../../src/config/network-schema.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { mirrorImageReference } from "../../src/infrastructure/containers/registry-image.js";

afterEach(() => vi.unstubAllEnvs());

test("default network YAML is created atomically, reused and overridden only by explicit paths", async () => {
  const path = defaultNetworkConfigPath();
  expect(path).toContain("evaluator-test-home-");
  const documents = await Promise.all(Array.from({ length: 8 }, () => loadNetworkConfig(undefined,
    { HTTP_PROXY: "http://user:secret@proxy.test", HF_ENDPOINT: "https://env.test" })));
  for (const document of documents) {
    expect(document.origin).toBe(path);
    expect(document.settings.proxy.host.http).toBe("http://user:secret@proxy.test");
    expect(document.settings.sources.huggingface).toBe("https://env.test");
  }
  expect(await readFile(path, "utf8")).not.toContain("secret");
  const custom = "sources:\n  huggingface: https://custom.test\n";
  await writeFile(path, custom);
  expect((await loadNetworkConfig(undefined, {})).settings.sources.huggingface).toBe("https://custom.test");
  expect(await readFile(path, "utf8")).toBe(custom);
  const other = join(path, "..", "explicit.yaml");
  await writeFile(other, "sources:\n  huggingface: https://explicit.test\n");
  expect((await loadNetworkConfig(undefined, { EVALUATOR_NETWORK_CONFIG: other })).settings.sources.huggingface).toBe("https://explicit.test");
  expect((await loadNetworkConfig(path, { EVALUATOR_NETWORK_CONFIG: other })).settings.sources.huggingface).toBe("https://custom.test");
  await expect(loadNetworkConfig(other + ".missing", {})).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "proxy: invalid\n");
  await expect(loadNetworkConfig(undefined, {})).rejects.toThrow("network.proxy must be an object");
  expect(await readFile(path, "utf8")).toBe("proxy: invalid\n");
});

test("environment overrides explicit YAML while unrelated fields and variable references are retained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-config-"));
  try {
    const path = join(directory, "network.yaml");
    await writeFile(path, 'proxy:\n  https: ${NODE_PROXY}\nsources:\n  huggingface: https://hub.test\n');
    const document = await loadNetworkConfig(path, { NODE_PROXY: "http://proxy.test:8080", HTTP_PROXY: "http://env.test", HF_ENDPOINT: "https://env.test" });
    expect(document.settings.proxy.host).toEqual({ http: "http://env.test", https: "http://proxy.test:8080", noProxy: [] });
    expect(document.settings.sources.huggingface).toBe("https://env.test");
    expect(document.settings.sources.npm.registry).toBe("https://registry.npmjs.org");
    await expect(loadNetworkConfig(path, {})).rejects.toThrow("NODE_PROXY");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([{}, { proxy: null }, { proxy: { http: null, https: null } }])("environment proxies apply to absent and direct YAML routes: %j", template => {
  const document = networkDocument(template, { HTTP_PROXY: "http://env-http.test:1", HTTPS_PROXY: "http://env-https.test:2", NO_PROXY: "localhost, .example.test" });
  for (const route of Object.values(document.settings.proxy))
    expect(route).toEqual({ http: "http://env-http.test:1", https: "http://env-https.test:2", noProxy: ["localhost", ".example.test"] });
});

test("environment overrides location routes field by field without losing null location semantics", () => {
  const template = { proxy: { http: "http://yaml-http.test", https: "http://yaml-https.test", noProxy: ["yaml.test"],
    overrides: { host: { http: "http://host.test" }, daemon: null, build: { https: "http://build.test", noProxy: ["build.test"] }, runtime: null } } };
  const original = structuredClone(template);
  const document = networkDocument(template, { HTTP_PROXY: "http://env.test" });
  expect(document.settings.proxy.host).toEqual({ http: "http://env.test", https: "http://yaml-https.test", noProxy: ["yaml.test"] });
  expect(document.settings.proxy.build).toEqual({ http: "http://env.test", https: "http://build.test", noProxy: ["build.test"] });
  for (const location of ["daemon", "runtime"] as const)
    expect(document.settings.proxy[location]).toEqual({ http: "http://env.test", https: null, noProxy: [] });
  expect(template).toEqual(original);
});

test("proxy aliases prefer nonempty uppercase values and empty variables preserve YAML", () => {
  const template = { proxy: { http: "http://yaml.test", https: "http://yaml.test", noProxy: ["yaml.test"] } };
  expect(networkDocument(template, { HTTP_PROXY: "", http_proxy: "http://lower.test", HTTPS_PROXY: "http://upper.test", https_proxy: "http://lower.test",
    NO_PROXY: "upper.test", no_proxy: "lower.test" }).settings.proxy.host)
    .toEqual({ http: "http://lower.test", https: "http://upper.test", noProxy: ["upper.test"] });
  expect(networkDocument(template, { HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "" }).settings.proxy.host)
    .toEqual({ http: "http://yaml.test", https: "http://yaml.test", noProxy: ["yaml.test"] });
});

test("source and build environment overrides preserve unrelated YAML configuration", () => {
  const document = networkDocument({ sources: { huggingface: "https://yaml.test", python: { index: "https://yaml.test/simple", extraIndexes: ["https://yaml.test/extra"] },
    github: { api: "https://yaml-api.test", raw: "https://yaml-raw.test" } },
    docker: { buildNetwork: "default", pull: { method: "registry-client" }, mirrors: { "docker.io": "https://mirror.test" } } }, {
    HF_ENDPOINT: "https://hub.test", UV_DEFAULT_INDEX: "https://python.test/simple", UV_INDEX_URL: "https://ignored.test", PIP_INDEX_URL: "https://ignored.test",
    PIP_EXTRA_INDEX_URL: "https://extra-one.test/simple  https://extra-two.test/simple", UV_PYTHON_INSTALL_MIRROR: "https://interpreter.test",
    NPM_CONFIG_REGISTRY: "https://npm.test", npm_config_registry: "https://ignored.test", EVALUATOR_NODE_MIRROR: "https://node.test/dist",
    EVALUATOR_GITHUB_MIRROR: "https://git.test", EVALUATOR_DEBIAN_MIRROR: "https://apt.test/", EVALUATOR_DOCKER_BUILD_NETWORK: "host",
  });
  expect(document.settings.sources).toEqual({ huggingface: "https://hub.test", python: { index: "https://python.test/simple",
    extraIndexes: ["https://extra-one.test/simple", "https://extra-two.test/simple"], interpreter: "https://interpreter.test" },
    npm: { registry: "https://npm.test" }, node: { dist: "https://node.test/dist" },
    github: { api: "https://yaml-api.test", raw: "https://yaml-raw.test", repository: "https://git.test" },
    apt: { debian: "https://apt.test/debian", debianSecurity: "https://apt.test/debian-security", ubuntu: "https://apt.test/ubuntu",
      ubuntuSecurity: "https://apt.test/ubuntu", ubuntuPorts: "https://apt.test/ubuntu-ports" } });
  expect(document.settings.docker).toMatchObject({ buildNetwork: "host", pull: { method: "registry-client" }, mirrors: { "docker.io": "https://mirror.test" } });
});

test.each([
  [{ PIP_INDEX_URL: "https://pip.test/simple" }, "https://pip.test/simple"],
  [{ UV_INDEX_URL: "https://uv.test/simple", PIP_INDEX_URL: "https://pip.test/simple" }, "https://uv.test/simple"],
  [{ UV_DEFAULT_INDEX: "", UV_INDEX_URL: "", PIP_INDEX_URL: "https://pip.test/simple" }, "https://pip.test/simple"],
])("Python index aliases select the first nonempty value: %j", (env, expected) => {
  expect(networkDocument({ sources: { python: { index: "https://yaml.test/simple", extraIndexes: ["https://extra.test"] } } }, env).settings.sources.python)
    .toMatchObject({ index: expected, extraIndexes: ["https://extra.test"] });
});

test("overrides replace YAML references before expansion and invalid environment values fail validation", () => {
  expect(networkDocument({ proxy: { https: "${MISSING_YAML_PROXY}" }, sources: { huggingface: "${MISSING_YAML_SOURCE}" } },
    { HTTPS_PROXY: "http://env.test", HF_ENDPOINT: "https://env.test" }).settings.sources.huggingface).toBe("https://env.test");
  expect(() => networkDocument({}, { HTTPS_PROXY: "invalid" })).toThrow("network.proxy.https");
  expect(() => networkDocument({}, { HF_ENDPOINT: "invalid" })).toThrow("network.sources.huggingface");
  expect(() => networkDocument({}, { EVALUATOR_DOCKER_BUILD_NETWORK: "invalid" })).toThrow("network.docker.buildNetwork");
  expect(() => networkDocument({ proxy: { unknown: true } }, { HTTPS_PROXY: "http://env.test" })).toThrow("Unknown network.proxy field");
  expect(() => networkDocument({ sources: null }, { HF_ENDPOINT: "https://env.test" })).toThrow("network.sources must be an object");
  expect(() => networkDocument({ sources: { python: [] } }, { PIP_INDEX_URL: "https://env.test/simple" })).toThrow("network.sources.python must be an object");
  expect(() => networkDocument({ docker: "invalid" }, { EVALUATOR_DOCKER_BUILD_NETWORK: "host" })).toThrow("network.docker must be an object");
});

test("saved environment overrides hide credentials and receiving nodes use their own environment", () => {
  const template = { proxy: { https: "http://yaml.test", overrides: { build: null } }, sources: { huggingface: "https://yaml-hub.test" } };
  const document = networkDocument(template, { HTTPS_PROXY: "http://user:coordinator-secret@coordinator.test", HF_ENDPOINT: "https://coordinator-hub.test" });
  const runtime = new NetworkRuntime(document);
  const snapshot = networkSnapshot(runtime, "fixture");
  expect(JSON.stringify(snapshot)).not.toContain("coordinator-secret");
  expect(JSON.stringify(runtime)).not.toContain("coordinator-secret");
  expect(runtime.secrets).toContain("coordinator-secret");
  const restored = restoreNetworkTemplate(snapshot.template, { HTTPS_PROXY: "http://user:node-secret@node.test", HF_ENDPOINT: "https://node-hub.test" });
  expect(restored.settings.proxy.build.https).toBe("http://user:node-secret@node.test");
  expect(restored.settings.sources.huggingface).toBe("https://node-hub.test");
  expect(restored.digest).not.toBe(document.digest);
  expect(() => restoreNetworkTemplate(snapshot.template, {})).toThrow("HTTPS_PROXY");
});

test("proxy overrides preserve explicit null and have independent noProxy arrays", () => {
  const settings = parseNetworkSettings({ proxy: { http: "http://host.test:1", https: "http://host.test:2", noProxy: ["localhost"],
    overrides: { build: { https: "http://build.test:3" }, runtime: null } } });
  expect(settings.proxy.build).toEqual({ http: "http://host.test:1", https: "http://build.test:3", noProxy: ["localhost"] });
  expect(settings.proxy.runtime).toEqual({ http: null, https: null, noProxy: [] });
  expect(settings.proxy.build.noProxy).not.toBe(settings.proxy.host.noProxy);
});

test("registry mirrors preserve image identity and match only the original registry", () => {
  const mirrors = { "docker.io": "https://docker.1panel.live/" };
  expect(mirrorImageReference("ubuntu:24.04", mirrors)).toBe("docker.1panel.live/library/ubuntu:24.04");
  const digest = `sha256:${"a".repeat(64)}`;
  expect(mirrorImageReference(`node@${digest}`, mirrors)).toBe(`docker.1panel.live/library/node@${digest}`);
  expect(mirrorImageReference("ghcr.io/team/image:1", mirrors)).toBe("ghcr.io/team/image:1");
});

test("archive requires a download root and rejects the removed catalog format", () => {
  const document = networkDocument({ docker: { pull: { method: "registry-client", backend: "skopeo" },
    benchmarks: { terminalbench: { method: "archive", provider: "modelscope", baseUrl: "https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0/" } } } }, {});
  expect(document.settings.docker.pull).toEqual({ method: "registry-client", backend: "skopeo", skopeoExecutable: "skopeo" });
  expect(document.settings.docker.benchmarks.terminalbench).toEqual({ method: "archive", provider: "modelscope",
    baseUrl: "https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0" });
  for (const config of [{ catalogs: { modelscope: "https://example.test/catalog.json" } }, { baseUrl: "" }, {}])
    expect(() => parseNetworkSettings({ docker: { benchmarks: {
      terminalbench: { method: "archive", provider: "modelscope", ...config },
    } } })).toThrow();
  for (const docker of [{ pull: { method: "archive" } }, { pull: { method: "registry-client", backend: "unknown" } },
    { pull: { method: "docker", backend: "nodejs" } }, { registryMirrors: [] }])
    expect(() => parseNetworkSettings({ docker })).toThrow();
});

test("credentials are redacted and Ray expands proxy references on the receiving node", () => {
  const runtime = new NetworkRuntime(networkDocument({ proxy: { https: "${NODE_PROXY}" } }, { NODE_PROXY: "http://user:host-secret@127.0.0.1:1" }));
  expect(JSON.stringify(redactNetwork(runtime.settings))).not.toContain("host-secret");
  const snapshot = networkSnapshot(runtime, "terminalbench");
  expect(JSON.stringify(snapshot)).not.toContain("host-secret");
  expect(restoreNetworkTemplate(snapshot.template, { NODE_PROXY: "http://node-proxy:2" }).settings.proxy.host.https).toBe("http://node-proxy:2");
  const literal = new NetworkRuntime(networkDocument({ proxy: { https: "http://user:secret@proxy.test:1" } }, {}));
  expect(() => networkSnapshot(literal, "terminalbench")).toThrow("node-local");
});

test("installer environments remove inherited network values and use container config paths", () => {
  const runtime = new NetworkRuntime(networkDocument({}, {}));
  const env = runtime.environment("runtime", { PATH: "/bin", PIP_INDEX_URL: "https://ignored.test", HTTPS_PROXY: "http://ignored.test", UV_PYTHON_INSTALL_MIRROR: "https://ignored.test" }, "container");
  expect(env.PATH).toBe("/bin");
  expect(env.HTTPS_PROXY).toBe("");
  expect(env.PIP_INDEX_URL).toBe("https://pypi.org/simple");
  expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
  expect(env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
});

test("concurrent HTTP instances keep endpoints and dispatchers separate, including redirects", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: "/final" }).end();
    else response.end(request.url);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const global = getGlobalDispatcher();
  vi.stubEnv("HTTP_PROXY", "http://unreachable.invalid:1");
  const first = new NetworkRuntime(networkDocument({ sources: { github: { raw: origin + "/one" } } }, {}));
  const second = new NetworkRuntime(networkDocument({ sources: { github: { raw: origin + "/two" } } }, {}));
  try {
    const values = await Promise.all([first, second].map(async runtime => (await runtime.fetch(runtime.sourceUrl("https://raw.githubusercontent.com/test"))).text()));
    expect(values).toEqual(["/one/test", "/two/test"]);
    const response = await first.fetch(origin + "/redirect");
    expect(response.redirected).toBe(true); expect(await response.text()).toBe("/final");
    expect(getGlobalDispatcher()).toBe(global);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
