import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { gzipSync } from "node:zlib";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { gatewaySource } from "../../src/infrastructure/network/model-gateway.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture(hosts: string[], withModel = true) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://blocked.invalid/" }); res.end(); }
    else if (req.url === "/compressed") {
      const body = gzipSync("compressed response");
      res.writeHead(200, { "content-encoding": "gzip", "content-length": body.length }); res.end(body);
    }
    else res.end("upstream");
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  const root = await mkdtemp(join(tmpdir(), "network-gateway-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\gateway-${address.port}` : join(root, "gateway.sock");
  const control = socket + ".control";
  const origin = `http://localhost:${address.port}`;
  const child = spawn(process.execPath, ["--input-type=module", "-", socket, withModel ? origin : "", "/v1", JSON.stringify(hosts), control], {
    env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_USE_ENV_PROXY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  await started(child);
  return { socket, control, origin, hits: () => hits };
}
async function started(child: ChildProcess) {
  await new Promise<void>((resolve, reject) => {
    let error = "";
    child.stderr?.on("data", chunk => { error += String(chunk); });
    child.once("exit", () => reject(new Error(error)));
    child.stdout?.once("data", () => resolve());
    child.stdin?.end(gatewaySource);
  });
}
async function get(socketPath: string, path: string, method = "GET", body?: string) {
  return await new Promise<{ status: number; body: string; location: string | undefined }>((resolve, reject) => {
    const req = request({ socketPath, path, method }, res => {
      let text = ""; res.on("data", chunk => { text += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, location: res.headers.location }));
    });
    req.on("error", reject); req.end(body);
  });
}

test("HTTP proxy checks target domains and redirects while model routing stays separate", async () => {
  const gateway = await fixture(["localhost"]);
  expect(await get(gateway.socket, gateway.origin + "/")).toMatchObject({ status: 200, body: "upstream" });
  expect(await get(gateway.socket, "http://blocked.invalid/")).toMatchObject({ status: 403 });
  expect(await get(gateway.socket, "http://localhost.evil.invalid/")).toMatchObject({ status: 403 });
  const redirect = await get(gateway.socket, gateway.origin + "/redirect");
  expect(redirect).toMatchObject({ status: 302, location: "http://blocked.invalid/" });
  expect(await get(gateway.socket, redirect.location!)).toMatchObject({ status: 403 });
  expect(await get(gateway.socket, "/v1/chat/completions")).toMatchObject({ status: 200 });
  expect(await get(gateway.socket, "/private")).toMatchObject({ status: 403 });
  expect(gateway.hits()).toBe(3);
});

test("empty and wildcard policies fail closed; control changes do not broaden model access", async () => {
  const gateway = await fixture(["*.localhost"]);
  expect(await get(gateway.socket, gateway.origin + "/")).toMatchObject({ status: 403 });
  expect(await get(gateway.control, "/", "POST", JSON.stringify(["localhost"]))).toMatchObject({ status: 200 });
  expect(await get(gateway.socket, gateway.origin + "/")).toMatchObject({ status: 200 });
  await get(gateway.control, "/", "POST", "[]");
  expect(await get(gateway.socket, gateway.origin + "/")).toMatchObject({ status: 403 });
  expect(await get(gateway.socket, "/v1/chat/completions")).toMatchObject({ status: 200 });
});

test("CONNECT tunnels only allowed destinations and policy transition closes existing tunnels", async () => {
  const gateway = await fixture(["localhost"]);
  const authority = new URL(gateway.origin).host;
  const denied = connect(gateway.socket);
  denied.write("CONNECT blocked.invalid:443 HTTP/1.1\r\nHost: blocked.invalid\r\n\r\n");
  expect(String((await once(denied, "data"))[0])).toContain("403 Forbidden");
  denied.destroy();
  const socket = connect(gateway.socket);
  cleanup.push(async () => { socket.destroy(); });
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  expect(String((await once(socket, "data"))[0])).toContain("200 Connection Established");
  const closed = once(socket, "close");
  await get(gateway.control, "/", "POST", "[]");
  socket.resume(); await closed;
});

test("HTTP proxy streams compressed response bytes without changing Content-Length", async () => {
  const gateway = await fixture(["localhost"]);
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: gateway.socket, path: gateway.origin + "/compressed" }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const body = Buffer.concat(chunks);
          expect(response.headers["content-encoding"]).toBe("gzip");
          expect(body).toEqual(gzipSync("compressed response"));
          expect(Number(response.headers["content-length"])).toBe(body.length);
          resolve();
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end();
  });
});

test("allowlisted verifier egress works without a model endpoint", async () => {
  const gateway = await fixture(["localhost"], false);
  expect(await get(gateway.socket, gateway.origin + "/")).toMatchObject({ status: 200 });
  expect(await get(gateway.socket, "/v1/chat/completions")).toMatchObject({ status: 403 });
});
