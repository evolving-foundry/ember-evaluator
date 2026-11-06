import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, test } from "vitest";
import { fetchNetworkResponse, retryNetworkOperation } from "../../src/infrastructure/network/retry.js";
import { completeJudge } from "../../src/infrastructure/models/judge.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const service = createServer(handler);
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); });
  const address = service.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic server port");
  return `http://127.0.0.1:${address.port}`;
}

test("only the failed request repeats; completed downloads remain completed", async () => {
  const counts = new Map<string, number>();
  const origin = await server((request, response) => {
    const path = request.url ?? "/";
    const count = (counts.get(path) ?? 0) + 1; counts.set(path, count);
    response.writeHead(path === "/second" && count < 3 ? 503 : 200); response.end("synthetic");
  });
  const init = { signal: AbortSignal.timeout(5000) };
  expect(await (await fetchNetworkResponse(origin + "/first", init, { backoffMs: 0 })).text()).toBe("synthetic");
  expect(await (await fetchNetworkResponse(origin + "/second", init, { backoffMs: 0 })).text()).toBe("synthetic");
  expect(Object.fromEntries(counts)).toEqual({ "/first": 1, "/second": 3 });
});

test("an interrupted response body retries the same request", async () => {
  let calls = 0;
  const origin = await server((_request, response) => {
    calls++;
    if (calls === 1) { response.writeHead(200, { "content-length": "100" }); response.write("partial"); setImmediate(() => response.destroy()); }
    else response.end("complete");
  });
  expect(await (await fetchNetworkResponse(origin, { signal: AbortSignal.timeout(5000) }, { backoffMs: 0 })).text()).toBe("complete");
  expect(calls).toBe(2);
});

test("a persistent failure exhausts the operation budget then reports NETWORK_FAILURE", async () => {
  let calls = 0;
  const origin = await server((_request, response) => { calls++; response.writeHead(503); response.end(); });
  await expect(fetchNetworkResponse(origin, { signal: AbortSignal.timeout(5000) }, { maxAttempts: 3, backoffMs: 0 }))
    .rejects.toMatchObject({ code: "NETWORK_FAILURE", details: { httpStatus: 503, networkStage: "dataset" } });
  expect(calls).toBe(3);
});

test("permanent HTTP rejection does not repeat", async () => {
  let calls = 0;
  const origin = await server((_request, response) => { calls++; response.writeHead(403); response.end(); });
  expect((await fetchNetworkResponse(origin, { signal: AbortSignal.timeout(5000) }, { backoffMs: 0 })).status).toBe(403);
  expect(calls).toBe(1);
});

test("a model quota rejection is permanent even when the service uses HTTP 429", async () => {
  let calls = 0;
  const origin = await server((_request, response) => { calls++; response.writeHead(429); response.end('{"error":{"code":"insufficient_quota"}}'); });
  await expect(fetchNetworkResponse(origin, { signal: AbortSignal.timeout(5000) }, {
    context: { phase: "solve", component: "model" }, backoffMs: 0,
  })).rejects.toMatchObject({ code: "MODEL_QUOTA_EXHAUSTED" });
  expect(calls).toBe(1);
});

test("cancellation interrupts backoff without another operation", async () => {
  const controller = new AbortController();
  const cancelled = new Error("synthetic cancellation");
  let calls = 0;
  const operation = retryNetworkOperation(async () => {
    calls++; setImmediate(() => controller.abort(cancelled)); throw new Error("ECONNRESET");
  }, { signal: controller.signal, context: { phase: "environment", operation: "pull" }, backoffMs: 60_000 });
  await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

test("judge SDK retries the same model request without replaying a scoring workflow", async () => {
  const prompts: string[] = [];
  const origin = await server(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    prompts.push(JSON.parse(body).messages[0].content);
    if (prompts.length === 1) { response.writeHead(503); response.end('{"error":{"message":"synthetic transient failure"}}'); return; }
    response.setHeader("content-type", "text/event-stream");
    for (const delta of [{ role: "assistant", content: "ready" }, {}]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta, finish_reason: "content" in delta ? null : "stop" }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  expect(await completeJudge("same request", { name: "fixture", endpoint: origin + "/v1", api: "openai-completions",
    provider: null, retry: { maxAttempts: 2 } }, { value: "synthetic-key", reference: null }, AbortSignal.timeout(10000)))
    .toBe("ready");
  expect(prompts).toEqual(["same request", "same request"]);
}, 15000);
