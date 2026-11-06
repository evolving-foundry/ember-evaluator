import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { connect, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterEach, expect, test, vi } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { installEnvProxy } from "../../src/infrastructure/network/env-proxy.js";

const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const originalCAs = getCACertificates("default");
const cert = readFileSync(new URL("../fixtures/http-protocol/server-cert.pem", import.meta.url), "utf8");
const key = readFileSync(new URL("../fixtures/http-protocol/server-key.pem", import.meta.url), "utf8");
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  const dispatcher = getGlobalDispatcher();
  if (dispatcher !== originalDispatcher) await dispatcher.destroy();
  setGlobalDispatcher(originalDispatcher);
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  setDefaultCACertificates(originalCAs);
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.each([undefined, "0", "1"])("negotiates the configured protocol with EVALUATOR_HTTP2=%s", async value => {
  await checkProtocol(value, false);
});

test.each([undefined, "0", "1"])("negotiates the configured protocol through a proxy with EVALUATOR_HTTP2=%s", async value => {
  await checkProtocol(value, true);
});

test.each([undefined, "1"])("Pi runner installs its own protocol policy with EVALUATOR_HTTP2=%s", async value => {
  await checkProtocol(value, true, true);
});

test.each([undefined, "0", "1"])("download runtime negotiates the configured direct protocol with EVALUATOR_HTTP2=%s", async value => {
  await checkProtocol(value, false, false, true);
});

test.each([undefined, "0", "1"])("download runtime negotiates the configured proxy protocol with EVALUATOR_HTTP2=%s", async value => {
  await checkProtocol(value, true, false, true);
});

async function checkProtocol(value: string | undefined, proxy: boolean, runner = false, download = false) {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  vi.stubEnv("EVALUATOR_HTTP2", value);
  setDefaultCACertificates([...originalCAs, cert]);
  const sockets = new Set<Socket>();
  const server = createSecureServer({ key, cert, allowHTTP1: true });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("request", (request, response) => response.end(request.httpVersion));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  let tunnels = 0;
  if (proxy) {
    const proxyServer = createServer();
    proxyServer.on("connect", (_request, client, head) => {
      tunnels++;
      const upstream = connect(address.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    await new Promise<void>(resolve => proxyServer.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => proxyServer.close(error => error ? reject(error) : resolve())));
    const proxyAddress = proxyServer.address();
    if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Expected a TCP proxy listener");
    // Exercise lowercase Git Bash variables as well as CONNECT tunnelling.
    vi.stubEnv("https_proxy", `http://127.0.0.1:${proxyAddress.port}`);
  }
  let network: NetworkRuntime | undefined;
  if (download) {
    const runtime = new NetworkRuntime(networkDocument({}, process.env));
    network = runtime;
    cleanup.push(() => runtime.dispose());
  } else if (runner) {
    vi.resetModules();
    await import("../../src/runtimes/pi/runner.js");
  } else installEnvProxy();
  const response = await (network?.fetch ?? fetch)(`https://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(3000) });
  expect(await response.text()).toBe(value === "1" ? "2.0" : "1.1");
  expect(tunnels).toBe(proxy ? 1 : 0);
}
