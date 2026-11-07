import type { JobsConfig } from "../../config/jobs.js";
import { retryNetworkOperation } from "../network/retry.js";
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectRecord, expectNonEmptyString, expectPositiveInteger, rejectUnknown } from "../../core/validation/input.js";
import type { ProgressListener } from "../../core/progress/progress.js";
import { parseProgressSnapshot } from "../../core/progress/progress-wire.js";

export class JobsClient {
  constructor(
    private readonly endpoint: string,
    private readonly ca: Buffer,
    private readonly token: string,
  ) {}
  static async create(
    config: JobsConfig,
    resolvePath: (path: string) => string,
    modelApiKeys: readonly string[] = [],
  ): Promise<JobsClient> {
    const caPath = resolvePath(config.caFile);
    const tokenPath = join(dirname(caPath), "jobs-token");
    let token = process.env[config.tokenEnv];
    let source = config.tokenEnv;
    if (!token) {
      source = tokenPath;
      try {
        token = (await readFile(tokenPath, "utf8")).trim();
      } catch (cause) {
        throw new Error(`Set ${config.tokenEnv} or provide the gateway credential in ${tokenPath}`, { cause });
      }
    }
    if (token.length < 32)
      throw new Error(`Jobs gateway credential from ${source} must be at least 32 characters`);
    if (modelApiKeys.includes(token))
      throw new Error("Jobs token must differ from the model API key");
    return new JobsClient(config.endpoint, await readFile(caPath), token);
  }
  async call(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const perform = () => new Promise<unknown>((resolve, reject) => {
      const req = request(
        new URL(path, this.endpoint),
        {
          ca: this.ca,
          method: data === undefined ? "GET" : "POST",
          ...(signal ? { signal } : {}),
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) res.destroy(new Error("Jobs response too large"));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(Object.assign(new Error(`Jobs API HTTP ${res.statusCode}; job may still be running, reconnect by ID`), { statusCode: res.statusCode }));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("Invalid Jobs API response"));
            }
          });
        },
      );
      req.setTimeout(30_000, () => req.destroy(Object.assign(new Error("Jobs API timeout; reconnect by job ID"), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      req.end(data);
    });
    // A failed read is repeatable; submitting a job may already have side effects.
    return data === undefined ? retryNetworkOperation(perform, {
      signal: signal ?? new AbortController().signal, context: { phase: "prepare", component: "scheduler" },
    }) : perform();
  }
  private async followProgress(id: string, log: (text: string) => void, signal: AbortSignal, onProgress: ProgressListener, pending: () => boolean): Promise<void> {
    let lastReceived = performance.now();
    let interrupted = false;
    const notify = (connection: "connected" | "interrupted") => onProgress({ phase: "progress", transient: true, connection,
      message: connection === "connected" ? "Progress connection restored" : "Progress connection interrupted; the cluster job may still be running" });
    while (!signal.aborted) {
      try {
        const snapshot = parseProgressSnapshot(await this.call(`/jobs/${encodeURIComponent(id)}/progress`, undefined,
          AbortSignal.any([signal, AbortSignal.timeout(2000)])));
        if (snapshot.publisherId !== "pending" && ((snapshot.ageMs ?? 0) < 10_000 || snapshot.ended)) {
          lastReceived = performance.now();
          if (interrupted) { interrupted = false; notify("connected"); }
          for (const event of snapshot.events) onProgress(event);
        }
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) {
          onProgress({ phase: "progress", message: "The gateway does not support live progress", transient: true, connection: "unsupported" });
          log("The cluster gateway does not support live progress; continuing with plain logs."); return;
        }
      }
      if (pending()) lastReceived = performance.now();
      if (!signal.aborted && performance.now() - lastReceived > 10_000 && !interrupted) { interrupted = true; notify("interrupted"); }
      try { await delay(1000, undefined, { signal }); } catch { return; }
    }
  }
  async attach(id: string, log: (text: string) => void, signal: AbortSignal, onProgress?: ProgressListener, progressJobId = id): Promise<number> {
    const stop = new AbortController();
    const progressSignal = AbortSignal.any([signal, stop.signal]);
    let pending = true;
    const following = onProgress ? this.followProgress(progressJobId, log, progressSignal, onProgress, () => pending).catch(() => {}) : Promise.resolve();
    let offset = 0;
    try {
      while (!signal.aborted) {
        const state = expectRecord(await this.call(`/jobs/${encodeURIComponent(id)}`, undefined, signal), "job status");
        pending = state.status === "PENDING";
        // A pending job may not have a driver/log file yet. Read status first so
        // the final ordinary log read follows the driver's terminal state.
        if (state.status !== "PENDING") {
          const logs = expectRecord(
            await this.call(`/jobs/${encodeURIComponent(id)}/logs`, undefined, signal),
            "job logs",
          );
          if (typeof logs.logs === "string") {
            const tail = logs.logs.slice(offset);
            if (tail) log(tail);
            offset = logs.logs.length;
          }
        }
        if (["SUCCEEDED", "FAILED", "STOPPED"].includes(String(state.status))) {
          log(JSON.stringify(state));
          return state.status === "SUCCEEDED" ? 0 : 1;
        }
        await delay(1000, undefined, { signal });
      }
      return 130;
    } finally {
      stop.abort(); await following;
      // The terminal status may arrive before the progress publisher's final flush.
      if (onProgress && !signal.aborted) {
        try {
          const snapshot = parseProgressSnapshot(await this.call(`/jobs/${encodeURIComponent(progressJobId)}/progress`, undefined, AbortSignal.timeout(2000)));
          for (const event of snapshot.events) onProgress(event);
        } catch { /* The result and saved formal logs remain authoritative. */ }
      }
    }
  }
}
