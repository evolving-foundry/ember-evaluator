import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import type { ActivityListener, ComponentActivity } from "../../core/contracts/activity.js";
import { byteSize, datasetActivity, datasetActivityListener, withDatasetActivity } from "./activity.js";

class DatasetHttpError extends Error {
  constructor(readonly status: number) {
    super(`Dataset HTTP ${status}`);
  }
}

class DatasetIdleTimeoutError extends Error {
  readonly code: ErrorCode = "NETWORK_FAILURE";
  readonly details = { networkStage: "dataset", networkEvidence: "dataset stream idle timeout" };
  constructor() {
    super("Dataset stream idle timeout: download made no progress for 60 seconds");
  }
}

function retryable(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof DatasetHttpError) return [408, 429, 500, 502, 503, 504].includes(error.status);
  if ("code" in error && typeof error.code === "string" && [
    "NETWORK_FAILURE", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EPIPE",
  ].includes(error.code)) return true;
  if (error instanceof AggregateError && error.errors.some(item => retryable(item, seen))) return true;
  return "cause" in error && retryable(error.cause, seen);
}

async function digestFile(path: string, signal: AbortSignal): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const hash = createHash("sha256");
    let checked = 0;
    let last = 0;
    for await (const bytes of createReadStream(path)) {
      signal.throwIfAborted();
      hash.update(bytes);
      checked += bytes.length;
      if (performance.now() - last >= 200) {
        datasetActivity(`Validating data cache ${byteSize(checked)} / ${byteSize(stat.size)}`);
        last = performance.now();
      }
    }
    return hash.digest("hex");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Content-addressed bytes. A temporary download is never a valid cache entry. */
export class DatasetCache {
  private readonly root: string;
  private readonly flights = new WeakMap<AbortSignal, Map<string, {
    promise: Promise<{ path: string; sha256: string }>;
    listeners: Set<ActivityListener>;
    latest?: ComponentActivity;
  }>>();
  constructor(root: string, private readonly network?: import("../../core/contracts/network.js").NetworkAccess) {
    this.root = resolve(root);
  }
  objectPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid cache digest");
    return join(this.root, "objects", digest);
  }

  /** Verify an existing object without contacting its source; discard corrupt files. */
  async cached(expected: string, signal: AbortSignal): Promise<{ path: string; sha256: string } | null> {
    signal.throwIfAborted();
    datasetActivity("Checking data cache and SHA-256");
    const path = this.objectPath(expected);
    if ((await digestFile(path, signal)) === expected) {
      datasetActivity("Data cache hit; SHA-256 validation passed");
      return { path, sha256: expected };
    }
    // A digest-named invalid file/junction is safe to unlink; never recursively remove it.
    const stat = await lstat(path).catch(error => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) throw new Error("Cache object is a directory");
    if (stat) await rm(path);
    signal.throwIfAborted();
    return null;
  }

  async fetch(
    url: string,
    expected: string | null,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<{ path: string; sha256: string }> {
    signal.throwIfAborted();
    url = this.network?.sourceUrl(url) ?? url;
    let flights = this.flights.get(signal);
    if (!flights) {
      flights = new Map();
      this.flights.set(signal, flights);
    }
    const key = `${url}\n${expected ?? ""}`;
    const existing = flights.get(key);
    const listener = datasetActivityListener();
    if (existing) {
      if (listener) existing.listeners.add(listener);
      try {
        if (listener && existing.latest) listener({ ...existing.latest, activity: false });
        return await existing.promise;
      } finally { if (listener) existing.listeners.delete(listener); }
    }
    const listeners = new Set<ActivityListener>(listener ? [listener] : []);
    const flight: NonNullable<ReturnType<typeof flights.get>> = {
      listeners,
      promise: Promise.resolve().then(() => withDatasetActivity(event => {
        flight.latest = event;
        for (const observe of listeners) observe(event);
      }, () => this.download(url, expected, signal, headers))).finally(() => flights!.delete(key)),
    };
    flights.set(key, flight);
    try { return await flight.promise; }
    finally { listeners.clear(); }
  }

  private async download(
    url: string,
    expected: string | null,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<{ path: string; sha256: string }> {
    await mkdir(join(this.root, "objects"), { recursive: true });
    if (expected !== null) {
      const cached = await this.cached(expected, signal);
      if (cached) return cached;
    }
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await this.downloadAttempt(url, expected, signal, headers);
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (attempt >= 3 || !retryable(cause)) {
          throw new Error(
            `Dataset download failed after ${attempt} attempt(s): ${redactDiagnostic(url)} (${redactDiagnostic(cause instanceof Error ? cause.message : String(cause))})`,
            { cause },
          );
        }
        datasetActivity(`Data download attempt ${attempt} failed; retrying after ${attempt}s`);
        await delay(1000 * attempt, undefined, { signal });
      }
    }
  }

  private async downloadAttempt(
    url: string,
    expected: string | null,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<{ path: string; sha256: string }> {
    const temporary = join(this.root, `.download-${randomUUID()}.tmp`);
    const idle = new AbortController();
    const requestSignal = AbortSignal.any([signal, idle.signal]);
    // Limit silence rather than total duration so large, progressing downloads
    // remain valid. The same deadline covers both headers and stalled bodies.
    let timer: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DatasetIdleTimeoutError()), 60_000);
      timer.unref();
    };
    resetIdle();
    try {
      // Never expose URL credentials, query parameters or private dataset paths.
      const host = new URL(url).hostname;
      datasetActivity(`Connecting to data source ${host}; waiting for a response`);
      const response = await (this.network?.fetch ?? fetch)(url, { signal: requestSignal, ...(headers === undefined ? {} : { headers }) });
      resetIdle();
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new DatasetHttpError(response.status);
      }
      const handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      let last = -Infinity;
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      const total = (!encoding || encoding.trim().toLowerCase() === "identity") && length !== null && /^\d+$/u.test(length) &&
        Number.isSafeInteger(Number(length)) && Number(length) > 0 ? Number(length) : undefined;
      const report = () => datasetActivity(`Downloading ${host}: ${byteSize(bytes)}${total !== undefined && bytes <= total ? ` / ${byteSize(total)} (${Math.floor(bytes / total * 100)}%)` : ""}`);
      try {
        for await (const chunk of response.body) {
          requestSignal.throwIfAborted();
          resetIdle();
          hash.update(chunk);
          bytes += chunk.length;
          await handle.writeFile(chunk);
          if (performance.now() - last >= 200) { report(); last = performance.now(); }
        }
        report();
        datasetActivity(`Download completed; ${expected === null ? "saving" : "validating"} ${byteSize(bytes)} of data`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      requestSignal.throwIfAborted();
      // Fetch yields decoded bytes; Content-Length measures the compressed wire
      // payload. Stream/decompression errors and the locked digest still detect
      // truncation/corruption for encoded responses.
      if ((!encoding || encoding.trim().toLowerCase() === "identity") && length !== null && Number(length) !== bytes)
        throw new Error("Truncated dataset download");
      const sha256 = hash.digest("hex");
      if (expected !== null && expected !== sha256) throw new Error("Locked dataset checksum mismatch");
      const path = this.objectPath(sha256);
      await rename(temporary, path);
      datasetActivity(expected === null ? `Data cached (${byteSize(bytes)})` : `Data cached; SHA-256 validation passed (${byteSize(bytes)})`);
      return { path, sha256 };
    } catch (cause) {
      if (idle.signal.aborted && !signal.aborted) throw idle.signal.reason;
      throw cause;
    } finally {
      clearTimeout(timer);
      await rm(temporary, { force: true });
    }
  }
}
