import { createHash } from "node:crypto";
import type { AptSources, ImageAcquisition, RegistryImageAcquisition, NetworkDocument, NetworkLocation, NetworkProxy, NetworkSettings } from "../core/contracts/network.js";
import type { JsonValue } from "../core/contracts/task.js";

const locations: NetworkLocation[] = ["host", "daemon", "build", "runtime"];
const aptKeys = ["debian", "debianSecurity", "ubuntu", "ubuntuSecurity", "ubuntuPorts"] as const;
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) throw new TypeError(`Unknown ${label} field: ${key}`);
  return result;
}
function url(value: unknown, label: string, credentials = false, origin = false): string {
  if (typeof value !== "string" || !value || /[\s\u0000-\u001f\\"'`$|]/u.test(value)) throw new TypeError(`${label} must be an HTTP(S) URL`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError(`${label} must be an HTTP(S) URL`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.search || parsed.hash ||
    (!credentials && (parsed.username || parsed.password)) || (origin && parsed.pathname !== "/"))
    throw new TypeError(`${label} must be a ${credentials ? "" : "credential-free "}HTTP(S) ${origin ? "origin" : "URL"}`);
  if (credentials) { try { decodeURIComponent(parsed.username); decodeURIComponent(parsed.password); } catch { throw new TypeError(`${label} has invalid credentials`); } }
  return origin && !credentials ? parsed.origin : parsed.href.replace(/\/$/u, "");
}
function list(value: unknown, label: string, urls = false): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item || /[\s\u0000-\u001f]/u.test(item)))
    throw new TypeError(`${label} must be an array of nonempty strings`);
  return [...new Set((value as string[]).map(item => urls ? url(item, label) : item))];
}
function proxy(value: unknown, defaults: NetworkProxy, label: string, overrides = false): NetworkProxy {
  if (value === null) return { http: null, https: null, noProxy: [] };
  const raw = record(value, overrides ? ["http", "https", "noProxy", "overrides"] : ["http", "https", "noProxy"], label);
  const entry = (key: "http" | "https") => raw[key] === undefined ? defaults[key] : raw[key] === null ? null : url(raw[key], `${label}.${key}`, true, true);
  return { http: entry("http"), https: entry("https"), noProxy: raw.noProxy === undefined ? [...defaults.noProxy] : list(raw.noProxy, `${label}.noProxy`) };
}

function acquisition(value: unknown, label: string, archive: false): RegistryImageAcquisition;
function acquisition(value: unknown, label: string, archive: true): ImageAcquisition;
function acquisition(value: unknown, label: string, archive: boolean): ImageAcquisition {
  const raw = record(value, ["method", "backend", "skopeoExecutable", "provider", "baseUrl"], label);
  const method = raw.method ?? "docker";
  if (method === "docker") { record(value, ["method"], label); return { method }; }
  if (method === "registry-client") {
    record(value, ["method", "backend", "skopeoExecutable"], label);
    const backend = raw.backend ?? "nodejs";
    if (backend !== "nodejs" && backend !== "skopeo") throw new TypeError(`${label}.backend must be nodejs or skopeo`);
    const executable = raw.skopeoExecutable ?? "skopeo";
    if (typeof executable !== "string" || !executable.trim() || /[\u0000-\u001f]/u.test(executable))
      throw new TypeError(`${label}.skopeoExecutable must be an executable name or path`);
    if (backend !== "skopeo" && raw.skopeoExecutable !== undefined) throw new TypeError(`${label}.skopeoExecutable requires backend skopeo`);
    return { method, backend, skopeoExecutable: executable };
  }
  if (archive && method === "archive") {
    record(value, ["method", "provider", "baseUrl"], label);
    if (raw.provider !== "modelscope" && raw.provider !== "huggingface") throw new TypeError(`${label}.provider must be modelscope or huggingface`);
    return { method, provider: raw.provider, baseUrl: url(raw.baseUrl, `${label}.baseUrl`) };
  }
  throw new TypeError(`${label}.method must be docker, registry-client${archive ? " or archive" : ""}`);
}

function dictionary(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function parseNetworkSettings(value: unknown): NetworkSettings {
  const raw = record(value, ["proxy", "sources", "docker", "git"], "network");
  const common = proxy(raw.proxy, { http: null, https: null, noProxy: [] }, "network.proxy", true);
  const proxyObject = record(raw.proxy === null ? undefined : raw.proxy, ["http", "https", "noProxy", "overrides"], "network.proxy");
  const overrides = record(proxyObject.overrides, locations, "network.proxy.overrides");
  const resolvedProxy = Object.fromEntries(locations.map(location => [location, proxy(overrides[location], common, `network.proxy.overrides.${location}`)])) as Record<NetworkLocation, NetworkProxy>;
  const sources = record(raw.sources, ["huggingface", "python", "npm", "node", "github", "apt"], "network.sources");
  const python = record(sources.python, ["index", "extraIndexes", "interpreter"], "network.sources.python");
  const npm = record(sources.npm, ["registry"], "network.sources.npm");
  const node = record(sources.node, ["dist"], "network.sources.node");
  const github = record(sources.github, ["api", "raw", "repository"], "network.sources.github");
  const apt = record(sources.apt, aptKeys, "network.sources.apt");
  const docker = record(raw.docker, ["pull", "mirrors", "benchmarks", "buildNetwork"], "network.docker");
  const pull = acquisition(docker.pull, "network.docker.pull", false);
  const mirrors = Object.fromEntries(Object.entries(dictionary(docker.mirrors, "network.docker.mirrors")).map(([registry, value]) => {
    if (!/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*|\[[a-f0-9:]+\])(?::[0-9]+)?$/u.test(registry)) throw new TypeError("network.docker.mirrors keys must be registry hosts");
    const origin = url(value, `network.docker.mirrors.${registry}`, false, true);
    if (!origin.startsWith("https:") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
      throw new TypeError("Docker mirrors require HTTPS except for loopback registries");
    return [registry, origin];
  }));
  const benchmarks = Object.fromEntries(Object.entries(dictionary(docker.benchmarks, "network.docker.benchmarks")).map(([name, value]) => {
    if (!name.trim() || /[\s\u0000-\u001f]/u.test(name)) throw new TypeError("Docker benchmark names must be nonempty identifiers");
    return [name, acquisition(value, `network.docker.benchmarks.${name}`, true)];
  }));
  const buildNetwork = docker.buildNetwork ?? "default";
  if (buildNetwork !== "default" && buildNetwork !== "host") throw new TypeError("network.docker.buildNetwork must be default or host");
  const git = record(raw.git, ["ssh"], "network.git");
  const ssh = record(git.ssh, ["route"], "network.git.ssh");
  const route = ssh.route ?? "direct";
  if (route !== "direct" && route !== "proxy") throw new TypeError("network.git.ssh.route must be direct or proxy");
  if (route === "proxy" && !resolvedProxy.host.https && !resolvedProxy.host.http)
    throw new TypeError("Git SSH proxy requires a host HTTP(S) proxy");
  return {
    proxy: resolvedProxy,
    sources: {
      huggingface: url(sources.huggingface ?? "https://huggingface.co", "network.sources.huggingface", false, true),
      python: { index: url(python.index ?? "https://pypi.org/simple", "network.sources.python.index"),
        extraIndexes: python.extraIndexes === undefined ? [] : list(python.extraIndexes, "network.sources.python.extraIndexes", true),
        interpreter: python.interpreter === undefined || python.interpreter === null ? null : url(python.interpreter, "network.sources.python.interpreter") },
      npm: { registry: url(npm.registry ?? "https://registry.npmjs.org", "network.sources.npm.registry") },
      node: { dist: url(node.dist ?? "https://nodejs.org/dist", "network.sources.node.dist") },
      github: { api: url(github.api ?? "https://api.github.com", "network.sources.github.api"),
        raw: url(github.raw ?? "https://raw.githubusercontent.com", "network.sources.github.raw"),
        repository: url(github.repository ?? "https://github.com", "network.sources.github.repository") },
      apt: Object.fromEntries(aptKeys.flatMap(key => apt[key] === undefined ? [] : [[key, url(apt[key], `network.sources.apt.${key}`)]])) as AptSources,
    },
    docker: { pull, mirrors, benchmarks, buildNetwork },
    git: { ssh: { route } },
  };
}

export function expandNetworkTemplate(value: unknown, env: NodeJS.ProcessEnv): JsonValue {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_]\w*)\}/gu, (_match, key: string) => {
    if (env[key] === undefined) throw new TypeError(`Network configuration references missing environment variable ${key}`);
    return env[key];
  });
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => expandNetworkTemplate(item, env));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandNetworkTemplate(item, env)]));
  throw new TypeError("Network configuration must contain JSON-compatible values");
}

type NetworkTemplateObject = { [key: string]: JsonValue };

function mergeNetworkTemplate(base: JsonValue | undefined, overrides: NetworkTemplateObject, label = "network"): NetworkTemplateObject {
  let result: NetworkTemplateObject;
  if (base === undefined || base === null && label.startsWith("network.proxy")) result = {};
  else {
    if (base === null || typeof base !== "object" || Array.isArray(base)) throw new TypeError(`${label} must be an object`);
    result = { ...base };
  }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = value !== null && typeof value === "object" && !Array.isArray(value)
      ? mergeNetworkTemplate(result[key], value, `${label}.${key}`) : value;
  }
  return result;
}

/** Override only nonempty variables; retain references for expansion on execution nodes. */
function applyNetworkEnvironment(template: JsonValue, env: NodeJS.ProcessEnv): JsonValue {
  const raw = record(template, ["proxy", "sources", "docker", "git"], "network");
  const proxy: NetworkTemplateObject = {}, python: NetworkTemplateObject = {}, sources: NetworkTemplateObject = {}, docker: NetworkTemplateObject = {};
  const reference = (names: string[]) => { const key = names.find(name => env[name]); return key ? `\${${key}}` : undefined; };
  const assign = (target: NetworkTemplateObject, key: string, names: string[]) => {
    const value = reference(names);
    if (value !== undefined) target[key] = value;
  };
  assign(proxy, "http", ["HTTP_PROXY", "http_proxy"]);
  assign(proxy, "https", ["HTTPS_PROXY", "https_proxy"]);
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) proxy.noProxy = noProxy.split(",").map(item => item.trim()).filter(Boolean);
  assign(sources, "huggingface", ["HF_ENDPOINT"]);
  assign(python, "index", ["UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL"]);
  if (env.PIP_EXTRA_INDEX_URL) python.extraIndexes = env.PIP_EXTRA_INDEX_URL.split(/\s+/u).filter(Boolean);
  assign(python, "interpreter", ["UV_PYTHON_INSTALL_MIRROR"]);
  if (Object.keys(python).length) sources.python = python;
  const npm = reference(["NPM_CONFIG_REGISTRY", "npm_config_registry"]);
  if (npm) sources.npm = { registry: npm };
  if (env.EVALUATOR_NODE_MIRROR) sources.node = { dist: "${EVALUATOR_NODE_MIRROR}" };
  if (env.EVALUATOR_GITHUB_MIRROR) sources.github = { repository: "${EVALUATOR_GITHUB_MIRROR}" };
  const apt = env.EVALUATOR_DEBIAN_MIRROR;
  if (apt) sources.apt = Object.fromEntries(Object.entries({ debian: "debian", debianSecurity: "debian-security",
    ubuntu: "ubuntu", ubuntuSecurity: "ubuntu", ubuntuPorts: "ubuntu-ports" }).map(([key, path]) =>
    [key, `\${EVALUATOR_DEBIAN_MIRROR}${apt.endsWith("/") ? "" : "/"}${path}`]));
  assign(docker, "buildNetwork", ["EVALUATOR_DOCKER_BUILD_NETWORK"]);
  const overrides: NetworkTemplateObject = {};
  if (Object.keys(proxy).length) {
    const common = record(raw.proxy === null ? undefined : raw.proxy, ["http", "https", "noProxy", "overrides"], "network.proxy");
    const locationsOverride = record(common.overrides, locations, "network.proxy.overrides");
    // Global environment routes win over every YAML location, including explicit null.
    overrides.proxy = { ...proxy, overrides: Object.fromEntries(locations.map(location => [location,
      locationsOverride[location] === null ? { http: null, https: null, noProxy: [], ...proxy } : { ...proxy }])) };
  }
  if (Object.keys(sources).length) overrides.sources = sources;
  if (Object.keys(docker).length) overrides.docker = docker;
  return mergeNetworkTemplate(template, overrides);
}

export function networkDocument(template: JsonValue, env: NodeJS.ProcessEnv, origin = "template"): NetworkDocument {
  template = applyNetworkEnvironment(template, env);
  const settings = parseNetworkSettings(expandNetworkTemplate(template, env));
  return { template: structuredClone(template), settings, origin,
    digest: createHash("sha256").update(JSON.stringify(redactNetwork(settings))).digest("hex") };
}
export function redactNetwork(value: unknown): JsonValue {
  if (typeof value === "string") {
    try { const parsed = new URL(value); if (parsed.username || parsed.password) { parsed.username = "redacted"; parsed.password = "redacted"; return parsed.href; } } catch { /* Non-URL configuration strings are public. */ }
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(redactNetwork);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactNetwork(item)]));
  return null;
}

export function networkSecrets(document: NetworkDocument | undefined): string[] {
  if (!document) return [];
  return Object.values(document.settings.proxy).flatMap(proxy => [proxy.http, proxy.https]).flatMap(value => {
    if (!value) return [];
    const url = new URL(value);
    return url.username || url.password ? [value, url.href, decodeURIComponent(url.password)].filter(Boolean) : [];
  });
}

/** Preserve variable references, never persist literal proxy credentials for reuse on another node. */
export function storedNetworkTemplate(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(storedNetworkTemplate);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storedNetworkTemplate(item)]));
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value);
    const credential = (part: string) => {
      const decoded = decodeURIComponent(part);
      return decoded !== "" && !/^(?:\$\{[A-Za-z_]\w*\})+$/u.test(decoded);
    };
    if (credential(parsed.username) || credential(parsed.password)) return "[runtime-provided]";
  } catch { /* Whole-value environment references are kept verbatim. */ }
  return value;
}

export function restoreNetworkTemplate(value: unknown, env: NodeJS.ProcessEnv): NetworkDocument {
  if (JSON.stringify(value).includes("[runtime-provided]"))
    throw new TypeError("Saved network configuration used literal credentials; supply --network with environment references");
  // Validate JSON shape before allowing a transport to supply a template.
  const template = expandNetworkTemplate(value, new Proxy({}, { get: (_target, key) => typeof key === "string" ? `\${${key}}` : undefined }));
  return networkDocument(template, env, "saved network template");
}

export function networkSnapshot(network: import("../core/contracts/network.js").NetworkAccess, benchmarkName: string): import("../core/contracts/network.js").NetworkSnapshot {
  const snapshot = { benchmarkName, template: storedNetworkTemplate(network.document.template) };
  validateNetworkSnapshot(snapshot);
  return snapshot;
}

/** Transport validation does not resolve variables on the sending machine. */
export function validateNetworkSnapshot(value: unknown): asserts value is import("../core/contracts/network.js").NetworkSnapshot {
  const raw = record(value, ["benchmarkName", "template"], "network snapshot");
  if (typeof raw.benchmarkName !== "string" || !raw.benchmarkName.trim()) throw new TypeError("Network snapshot benchmarkName is missing");
  const template = expandNetworkTemplate(raw.template, new Proxy({}, { get: (_target, key) => typeof key === "string" ? `\${${key}}` : undefined }));
  if (JSON.stringify(template).includes("[runtime-provided]") || JSON.stringify(storedNetworkTemplate(template)) !== JSON.stringify(template))
    throw new TypeError("Ray network credentials must use node-local environment references");
  const visit = (value: JsonValue): void => {
    if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
      if (key === "skopeoExecutable" && typeof item === "string" && /[/\\]/u.test(item) && !/^\$\{[A-Za-z_]\w*\}$/u.test(item))
        throw new TypeError("Ray skopeoExecutable paths must use a node-local environment reference");
      visit(item);
    }
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(template);
}
