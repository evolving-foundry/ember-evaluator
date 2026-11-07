import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { AttemptKey } from "../../core/contracts/result.js";
import { DOCKER_PLATFORM, PINNED_NODE_IMAGE, type DockerCommand } from "../containers/runtime-contract.js";
import { removeDockerContainer } from "../containers/cleanup.js";
import { normalizeAllowedHosts } from "../../core/policies/network-policy.js";
import { egressProxySource } from "./egress-proxy.js";

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "ModelGatewayError";
  }
}

/** The only upstream the gateway will ever talk to, derived from model.endpoint. */
export type ModelEndpointPolicy = {
  /** scheme://host[:port] the gateway forwards to. */
  origin: string;
  /** API path prefix requests must stay inside ("" allows the origin root). */
  pathPrefix: string;
};

/** Host loopback endpoints are reached through Docker's explicit host-gateway alias. */
export function dockerHostModelEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return endpoint;
  url.hostname = "host.docker.internal";
  return url.href;
}

export function parseModelEndpointPolicy(endpoint: string): ModelEndpointPolicy {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new ModelGatewayError("CONFIG_INVALID", "model endpoint must be a URL", cause);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ModelGatewayError("CONFIG_INVALID", "model endpoint must be a credential-free HTTP(S) URL");
  // URL normalizes dot segments; empty paths mean the whole origin is allowed.
  const rawPath = url.pathname.replace(/\/+$/u, "");
  if (rawPath.includes("//"))
    throw new ModelGatewayError("CONFIG_INVALID", "model endpoint path must be normalized");
  return { origin: url.origin, pathPrefix: rawPath };
}

/** Loopback port the in-container forwarder listens on; namespaces are private. */
export const MODEL_FORWARDER_PORT = 18080;
const GATEWAY_SOCKET_MOUNT = "/run/model-gateway";
const GATEWAY_SOCKET_CONTAINER = `${GATEWAY_SOCKET_MOUNT}/gateway.sock`;
const GATEWAY_SCRIPT_CONTAINER = "/tmp/model-gateway.mjs";
const GATEWAY_STARTUP_TIMEOUT_MS = 90_000;
// A successful connect must exit immediately: the gateway keeps the socket
// open waiting for a request, so end() alone would run into the timer.
const PROBE_SCRIPT =
  "const n=require('node:net');const target=JSON.parse(process.argv[1]);"
  + "const deadline=Date.now()+60000;const probe=()=>{const s=n.connect(target);"
  + "s.setTimeout(3000,()=>s.destroy());s.on('connect',()=>{s.destroy();process.exit(0);});"
  + "s.on('error',()=>{});s.on('close',()=>{if(Date.now()>=deadline)process.exit(2);else setTimeout(probe,250);});};probe();";

async function probeEndpoint(command: DockerCommand, containerId: string, target: { path: string } | { port: number; host: string },
  signal: AbortSignal, code: ErrorCode, message: string): Promise<void> {
  signal.throwIfAborted();
  try {
    // Starting Node itself may exceed 5s under emulation/load. Launch one probe
    // and retry connections inside it, preserving the parent's cancellation.
    await command(["exec", containerId, "node", "-e", PROBE_SCRIPT, JSON.stringify(target)], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(GATEWAY_STARTUP_TIMEOUT_MS)]),
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw new ModelGatewayError(code, message, cause);
  }
}

/**
 * Runs inside the gateway container (pinned Node image). An HTTP server on a
 * Unix socket with a dedicated model route restricted to origin/path and an
 * optional domain-checked HTTP/CONNECT proxy. Model redirects stay inside
 * origin/path; responses stream
 * with backpressure and client aborts cancel the upstream request. Credential
 * headers pass through but are never logged.
 */
export const gatewaySource = egressProxySource + String.raw`import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const [socketPath, origin, prefix, hosts = "null", controlSocket = "/tmp/egress-control.sock"] = process.argv.slice(2);
await rm(socketPath, { force: true });
await rm(controlSocket, { force: true });
const allowed = path => prefix === "" || path === prefix || path.startsWith(prefix + "/");
const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const server = createServer((request, response) => {
  const abort = new AbortController();
  response.on("close", () => abort.abort());
  (async () => {
    if (request.method === "CONNECT") { response.writeHead(405, { "content-type": "text/plain" }); response.end("CONNECT is not allowed"); return; }
    const proxyRequest = /^[a-z][a-z0-9+.-]*:/i.test(request.url ?? "");
    const incoming = new URL(request.url ?? "/", origin || "http://model.invalid");
    if (proxyRequest ? incoming.protocol !== "http:" || incoming.username || incoming.password || !egress.allowed(incoming.hostname)
      : !origin || incoming.origin !== origin || !allowed(incoming.pathname)) {
      response.writeHead(403); response.end("Destination is outside the network policy"); return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !hopByHop.has(name)));
    if (proxyRequest) { egress.forward(request, response, incoming, headers); return; }
    let target = incoming.pathname + incoming.search;
    for (let attempt = 0; attempt < 5; attempt++) {
      const upstream = await fetch(origin + target, {
        method: request.method,
        headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: Readable.toWeb(request), duplex: "half" }),
        redirect: "manual",
        signal: abort.signal,
      });
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        const location = upstream.headers.get("location");
        if (location === null) break;
        let next;
        try { next = new URL(location, origin + target); } catch { response.writeHead(502); response.end("Invalid redirect"); return; }
        if (next.origin !== origin) { response.writeHead(502, { "content-type": "text/plain" }); response.end("Cross-origin redirects are not allowed"); return; }
        if (!allowed(next.pathname)) { response.writeHead(403); response.end("Path is outside the model API prefix"); return; }
        target = next.pathname + next.search;
        continue;
      }
      const responseHeaders = Object.fromEntries([...upstream.headers].filter(([name]) => !hopByHop.has(name)));
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body === null) { response.end(); return; }
      await pipeline(Readable.fromWeb(upstream.body), response);
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" }); response.end("Too many redirects");
  })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
});
const egress = installEgressProxy(server, JSON.parse(hosts));
server.on("connection", socket => egress.track(socket));
// The control socket is outside the task's mounted volume. Only Docker exec in
// the gateway namespace can change policy; task requests cannot reach it.
const control = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    try { egress.update(JSON.parse(body)); response.end("ok"); }
    catch { response.writeHead(400); response.end(); }
  });
});
await new Promise((resolve, reject) => { control.once("error", reject); control.listen(controlSocket, resolve); });
server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
process.stdout.write("model-gateway listening\n");
`;

/**
 * Runs inside the solve container: a byte-level TCP tunnel from loopback to
 * the shared gateway socket. The container itself stays on --network none.
 */
export const forwarderSource = String.raw`import { createServer, connect } from "node:net";
const [socketPath, port] = [process.argv[2], Number(process.argv[3])];
const server = createServer(socket => {
  const upstream = connect(socketPath);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.pipe(upstream);
  upstream.pipe(socket);
  socket.on("close", () => upstream.end());
  upstream.on("close", () => socket.end());
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
process.stdout.write("model-forwarder listening\n");
`;

export type GatewayHandle = {
  containerId: string;
  image: string;
  /** Named volume holding the shared socket; mounted into both containers. */
  volume: string;
  setAllowedHosts(hosts: string[], signal: AbortSignal): Promise<void>;
  suspend(signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  /** Stop egress while the task still mounts the socket volume. */
  stop(signal?: AbortSignal): Promise<void>;
  dispose(signal?: AbortSignal): Promise<void>;
};

/**
 * Deterministic socket volume so crash recovery can sweep stale volumes. The
 * volume lives in the Docker VM's Linux filesystem so Unix socket semantics
 * hold even when the coordinator host is Windows.
 */
export function gatewayVolumeName(key: AttemptKey, phase: "solve" | "verify"): string {
  const identity = createHash("sha256")
    .update(JSON.stringify([key.runId, key.taskId, key.attemptId, phase]))
    .digest("hex")
    .slice(0, 24);
  return `ember-gateway-${identity}`;
}

function containerLabels(key: AttemptKey, phase: "solve" | "verify"): string[] {
  return (
    [
      ["run", key.runId],
      ["task", key.taskId],
      ["attempt", key.attemptId],
      ["phase", phase],
    ] as const
  ).flatMap(([name, value]) => ["--label", `ember.${name}=${value.replaceAll(/[\u0000-\u001f\u007f]/gu, "_")}`]);
}

async function probeSocket(command: DockerCommand, containerId: string, signal: AbortSignal): Promise<void> {
  await probeEndpoint(command, containerId, { path: GATEWAY_SOCKET_CONTAINER }, signal,
    "ENV_CONTAINER_START_FAILED", `model gateway socket did not start accepting in ${containerId}`);
}

/**
 * Create the per-attempt model gateway container. Only this container has
 * external network access; the socket volume it publishes is what isolated
 * containers mount to reach the model API.
 */
export async function createModelGateway(
  command: DockerCommand,
  options: {
    platform?: ContainerPlatform;
    endpoint?: string;
    allowedHosts?: string[];
    key: AttemptKey;
    phase: "solve" | "verify";
    proxyEnv?: string[];
    preparedImage?: string;
    signal: AbortSignal;
  },
): Promise<GatewayHandle> {
  options.signal.throwIfAborted();
  const policy = options.endpoint ? parseModelEndpointPolicy(dockerHostModelEndpoint(options.endpoint)) : null;
  const hosts = options.allowedHosts === undefined ? null : normalizeAllowedHosts(options.allowedHosts);
  const volume = gatewayVolumeName(options.key, options.phase);
  await command(["volume", "rm", "--force", volume], { signal: options.signal }).catch(() => {});
  await command(["volume", "create", ...containerLabels(options.key, options.phase), volume], { signal: options.signal });
  const context = await mkdtemp(join(tmpdir(), "ember-gateway-build-"));
  let containerId: string | null = null;
  try {
    await writeFile(join(context, "model-gateway.mjs"), gatewaySource, { mode: 0o600 });
    const createArgs = [
      "create",
      "--init",
      "--platform", options.platform ?? DOCKER_PLATFORM,
      ...containerLabels(options.key, options.phase),
      "--add-host",
      "host.docker.internal:host-gateway",
      ...(options.proxyEnv ?? []).flatMap(value => ["--env", value]),
      "--mount",
      `type=volume,source=${volume},target=${GATEWAY_SOCKET_MOUNT}`,
      ...(options.preparedImage ? ["--pull", "never"] : []),
      options.preparedImage ?? PINNED_NODE_IMAGE,
      "node",
      GATEWAY_SCRIPT_CONTAINER,
      GATEWAY_SOCKET_CONTAINER,
      policy?.origin ?? "",
      policy?.pathPrefix ?? "",
      JSON.stringify(hosts),
    ];
    containerId = (await command(createArgs, { signal: options.signal })).stdout.trim();
    if (!/^[a-f0-9]{12,64}$/u.test(containerId))
      throw new ModelGatewayError("ENV_CONTAINER_START_FAILED", "Docker returned an invalid gateway container ID");
    await command(["cp", join(context, "model-gateway.mjs"), `${containerId}:${GATEWAY_SCRIPT_CONTAINER}`], {
      signal: options.signal,
    });
    await command(["start", containerId], { signal: options.signal });
    await probeSocket(command, containerId, options.signal);
  } catch (error) {
    if (containerId) await removeDockerContainer(command, containerId, AbortSignal.timeout(55_000)).catch(() => {});
    await command(["volume", "rm", "--force", volume], { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    throw error;
  } finally {
    await rm(context, { recursive: true, force: true }).catch(() => {});
  }
  const id = containerId;
  let stopping: Promise<void> | null = null;
  let disposal: Promise<void> | null = null;
  const stop = (signal = AbortSignal.timeout(60_000)) => {
    stopping ??= removeDockerContainer(command, id, signal).catch(error => {
      if (!(error instanceof Error && /No such container/iu.test(error.message)))
        throw new ModelGatewayError("CLEANUP_FAILED", `failed to remove model gateway ${id}`, error);
    });
    return stopping;
  };
  return {
    containerId: id,
    image: options.preparedImage ?? PINNED_NODE_IMAGE,
    volume,
    stop,
    async suspend(signal) {
      await command(["stop", "--time", "0", id], { signal });
    },
    async resume(signal) {
      await command(["start", id], { signal });
      await probeSocket(command, id, signal);
    },
    async setAllowedHosts(hosts, signal) {
      const script = "const h=require('node:http');const r=h.request({socketPath:'/tmp/egress-control.sock',method:'POST'},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1));});r.on('error',()=>process.exit(1));r.end(process.argv[1]);";
      await command(["exec", id, "node", "-e", script, JSON.stringify(normalizeAllowedHosts(hosts))], { signal });
    },
    dispose(signal = AbortSignal.timeout(60_000)) {
      if (disposal) return disposal;
      disposal = (async () => {
        await stop(signal);
        try {
          await command(["volume", "rm", "--force", volume], {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          });
        } catch (error) {
          if (!(error instanceof Error && /No such volume/iu.test(error.message)))
            throw new ModelGatewayError("CLEANUP_FAILED", `failed to remove gateway volume ${volume}`, error);
        }
      })();
      return disposal;
    },
  };
}

/** Start the in-container loopback forwarder and wait until it accepts connections. */
export async function startModelForwarder(
  command: DockerCommand,
  containerId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await command(
    [
      "exec",
      "--detach",
      containerId,
      "node",
      "/opt/evaluator/model-forwarder.mjs",
      GATEWAY_SOCKET_CONTAINER,
      String(MODEL_FORWARDER_PORT),
    ],
    { signal },
  );
  await probeEndpoint(command, containerId, { port: MODEL_FORWARDER_PORT, host: "127.0.0.1" }, signal,
    "ENV_CONTAINER_START_FAILED", `loopback forwarder did not start in ${containerId}`);
}

/** Sweep socket volumes a crashed coordinator may have leaked. */
export async function cleanupGatewayVolumes(
  command: DockerCommand,
  keys: AttemptKey[],
  signal: AbortSignal,
): Promise<void> {
  for (const key of keys) {
    signal.throwIfAborted();
    for (const phase of ["solve", "verify"] as const) {
      await command(["volume", "rm", "--force", gatewayVolumeName(key, phase)], { signal }).catch(() => {});
    }
  }
}

/** Credential-free proxy variables the gateway itself may need for egress. */
export function gatewayProxyEnv(forwarded: string[]): string[] {
  return forwarded.filter(value => !/^NPM_CONFIG_REGISTRY=/u.test(value));
}

/** Container path isolated environments mount the shared socket volume at. */
export const GATEWAY_SOCKET_TARGET = GATEWAY_SOCKET_MOUNT;
