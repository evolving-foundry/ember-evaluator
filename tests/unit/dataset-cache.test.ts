import "../fixtures/network-fetch.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DatasetCache } from "../../src/infrastructure/datasets/cache.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dataset-retry-"));
  roots.push(root);
  return { root, cache: new DatasetCache(root) };
}

const signal = () => new AbortController().signal;
const timeout = () => new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });

test("recovers from the observed headers timeout and reuses the verified cached object", async () => {
  const { root, cache } = await setup();
  const fetch = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(new Response("task instructions"));
  vi.stubGlobal("fetch", fetch);
  const digest = createHash("sha256").update("task instructions").digest("hex");
  const result = await cache.fetch("https://example.test/instruction.md", digest, signal());
  expect(await readFile(result.path, "utf8")).toBe("task instructions");
  expect(await cache.fetch("https://example.test/instruction.md", digest, signal())).toEqual(result);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await readdir(root)).some(name => name.startsWith(".download-"))).toBe(false);
});

test.each(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"])("stops after three %s failures and preserves the underlying cause", async code => {
  const { cache } = await setup();
  const error = new TypeError("terminated", { cause: Object.assign(new Error("response interrupted"), { code }) });
  const fetch = vi.fn().mockRejectedValue(error);
  vi.stubGlobal("fetch", fetch);
  await expect(cache.fetch("https://example.test/file", null, signal())).rejects.toMatchObject({ cause: error });
  expect(fetch).toHaveBeenCalledTimes(3);
});

test.each(["UND_ERR_SOCKET", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"])("an interrupted body (%s) restarts from scratch and removes its incomplete file", async code => {
  const { root, cache } = await setup();
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks++ === 0) controller.enqueue(new TextEncoder().encode("incomplete prefix"));
      else controller.error(new TypeError("terminated", { cause: Object.assign(new Error("response interrupted"), { code }) }));
    },
  }, { highWaterMark: 0 });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(new Response("complete file"));
  vi.stubGlobal("fetch", fetch);
  const result = await cache.fetch("https://example.test/file", null, signal());
  expect(await readFile(result.path, "utf8")).toBe("complete file");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect((await readdir(root)).some(name => name.startsWith(".download-"))).toBe(false);
  expect(await readdir(join(root, "objects"))).toEqual([result.sha256]);
});

test("retries a temporary HTTP failure but leaves permanent responses and checksum failures visible", async () => {
  const { cache } = await setup();
  const fetch = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    .mockResolvedValueOnce(new Response("ok"))
    .mockResolvedValueOnce(new Response("not found", { status: 404 }))
    .mockResolvedValueOnce(new Response("wrong content"));
  vi.stubGlobal("fetch", fetch);
  await cache.fetch("https://example.test/transient", null, signal());
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(cache.fetch("https://example.test/missing", null, signal())).rejects.toThrow("Dataset HTTP 404");
  expect(fetch).toHaveBeenCalledTimes(3);
  await expect(cache.fetch("https://example.test/tampered", "0".repeat(64), signal())).rejects.toThrow("checksum mismatch");
  expect(fetch).toHaveBeenCalledTimes(4);
});

test("cancellation during backoff stops the next request", async () => {
  const { cache } = await setup();
  const controller = new AbortController();
  const fetch = vi.fn().mockRejectedValue(timeout());
  vi.stubGlobal("fetch", fetch);
  const pending = cache.fetch("https://example.test/file", null, controller.signal);
  const checked = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  controller.abort(new Error("user cancelled"));
  await checked;
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("an unresponsive headers request is cancelled before the default five minute timeout", async () => {
  const { cache } = await setup();
  vi.useFakeTimers();
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const active = options.signal;
    if (!active) throw new Error("Expected request cancellation signal");
    requestSignal = active;
    active.addEventListener("abort", () => reject(active.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const pending = cache.fetch("https://example.test/stalled", null, controller.signal);
  const checked = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(requestSignal?.aborted).toBe(true);
  expect(requestSignal?.reason.message).toMatch(/no progress/);
  controller.abort(new Error("cancel retry"));
  await checked;
  expect(fetch).toHaveBeenCalledTimes(1);
});
