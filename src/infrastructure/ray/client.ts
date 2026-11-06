import { assertEnvironmentTimeouts } from "../../core/preparation/preparation-validation.js";
import { isErrorCode, type ErrorCode } from "../../core/errors/registry.js";
import { identifyNetworkFailure } from "../../core/errors/network-failure.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteJob } from "./protocol.js";
import { parseImageCleanupRequest, parseImageCleanupSummary } from "./image-cleanup.js";
import { expectRecord } from "../../core/validation/input.js";
import type { ImageCleanupNode } from "../../core/contracts/image-cleanup.js";
import type { UploadReceipt } from "../transfer/protocol.js";
import type { AttemptKey } from "../../core/contracts/result.js";

export type RayReady = {
  type: "ready";
  schemaVersion: 2;
  rayVersion: string;
  pythonVersion: string;
  nodes: string[];
  nodeSlots: Record<string, number>;
  slots: number;
};
export type RayResult =
  | { type: "prepared"; attemptId: string; result: { preparationDigest: string; nodeId: string; hostname: string; warnings?: string[];
      environmentTimeouts?: import("../../core/contracts/result.js").TaskPreparationTiming["environmentTimeouts"] } }
  | { type: "result"; attemptId: string; result: { receipt: UploadReceipt; nodeId: string; hostname: string; warnings?: string[] } }
  | { type: "failed"; attemptId: string; code: ErrorCode; originalName?: string; retired?: boolean; network?: import("../../core/contracts/errors.js").ErrorDetails | null;
      environmentTimeouts?: import("../../core/contracts/result.js").TaskPreparationTiming["environmentTimeouts"] };
export type RayClientOptions = {
  imageGuard?: unknown;
  pythonExecutable: string;
  driverPath: string;
  endpoint: string;
  startupTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  concurrency?: number;
  nodes?: number;
};

/** Owns one Python process. Only explicit credential-free protocol messages cross stdin. */
export class RayClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly ready = Promise.withResolvers<RayReady>();
  private readonly exited = Promise.withResolvers<void>();
  private readonly pending = new Map<string, ReturnType<typeof Promise.withResolvers<RayResult>>>();
  private readonly cleaned = Promise.withResolvers<void>();
  private readonly maintenance = new Map<string, { waiting: ReturnType<typeof Promise.withResolvers<ImageCleanupNode[]>>; preview: boolean; nodes: Set<string> }>();
  private readonly retired = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  private failure: Error | undefined;
  private closing = false;
  /** Coordinator-side dispatch cap; set after the cluster slot count is known. */
  limit: number | undefined;
  slots = 0;
  nodes: string[] = [];
  nodeSlots: Record<string, number> = {};
  constructor(private readonly options: RayClientOptions) {
    void this.ready.promise.catch(() => {});
    void this.cleaned.promise.catch(() => {});
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.ready.reject(error);
    this.cleaned.reject(error);
    for (const operation of this.maintenance.values()) operation.waiting.reject(error);
    this.maintenance.clear();
    for (const value of this.pending.values()) value.reject(error);
    this.pending.clear();
    for (const value of this.retired.values()) value.reject(error);
    this.retired.clear();
  }
  private send(value: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child || this.closing) throw new Error("Ray driver is not available");
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error("Ray request exceeds protocol limit");
    this.child.stdin.write(line);
  }
  async start(signal: AbortSignal): Promise<RayReady> {
    signal.throwIfAborted();
    if (this.child) throw new Error("Ray driver already started");
    const child = (this.child = spawn(this.options.pythonExecutable, [this.options.driverPath], {
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    }));
    child.on("error", () => {
      this.fail(new Error("Ray driver process could not start"));
      this.exited.resolve();
    });
    child.stdin.on("error", () => this.fail(new Error("Ray driver input closed")));
    child.stderr.resume(); // Python diagnostics can contain paths; structured errors are the public contract.
    child.on("close", () => {
      if (!this.closing) this.fail(new Error("Ray driver disconnected"));
      this.exited.resolve();
    });
    let bytes = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        bytes = Buffer.concat([bytes, chunk]);
        for (;;) {
          const newline = bytes.indexOf(10);
          if (newline < 0) break;
          if (newline > 2 * 1024 * 1024) throw new Error("Ray response exceeds protocol limit");
          const value = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
          bytes = bytes.subarray(newline + 1);
          if (value.type === "ready") {
            if (
              value.schemaVersion !== 2 ||
              value.rayVersion !== "2.58.0" ||
              value.pythonVersion !== "3.12.14" ||
              !Array.isArray(value.nodes) ||
              value.nodes.some(node => typeof node !== "string" || !node) ||
              typeof value.slots !== "number" ||
              !Number.isSafeInteger(value.slots) ||
              value.slots < 1
            ) {
              throw new Error("Ray driver version or cluster handshake mismatch");
            }
            if (!value.nodeSlots || typeof value.nodeSlots !== "object" || Array.isArray(value.nodeSlots) ||
              value.nodes.some(node => !Number.isSafeInteger((value.nodeSlots as Record<string, number>)[String(node)]) || (value.nodeSlots as Record<string, number>)[String(node)]! < 1))
              throw new Error("Invalid Ray node capacity");
            this.nodes = value.nodes as string[];
            this.nodeSlots = value.nodeSlots as Record<string, number>;
            this.slots = value.slots;
            this.ready.resolve(value as RayReady);
          } else if (value.type === "result" || value.type === "prepared" || value.type === "failed") {
            if (typeof value.attemptId !== "string" || !this.pending.has(value.attemptId))
              throw new Error("Unexpected Ray attempt response");
            if (
              value.type === "failed" &&
              !isErrorCode(value.code)
            )
              throw new Error("Invalid Ray failure code");
            if (value.originalName !== undefined && (typeof value.originalName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(value.originalName)))
              throw new Error("Invalid Ray external exception name");
            if (value.type === "failed" && value.network != null) {
              const network = identifyNetworkFailure([{ code: value.code, details: value.network }], { phase: "environment" });
              if (!network) throw new Error("Invalid Ray network evidence");
              value.network = network;
            }
            if (value.retired !== undefined && typeof value.retired !== "boolean") throw new Error("Invalid Ray retirement confirmation");
            if (value.type === "failed") assertEnvironmentTimeouts(value.environmentTimeouts);
            if (value.type !== "failed") {
              const result = value.result as Record<string, unknown> | undefined;
              if (result?.warnings !== undefined && (!Array.isArray(result.warnings) || result.warnings.length > 8
                || result.warnings.some((entry: unknown) => typeof entry !== "string" || entry.length > 4096 || /[\u0000-\u001f\u007f]/u.test(entry))))
                throw new Error("Invalid Ray runtime warnings");
            }
            if (value.type === "prepared") {
              const result = value.result as Record<string, unknown> | undefined;
              if (!result || typeof result.preparationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(result.preparationDigest) ||
                typeof result.nodeId !== "string" || typeof result.hostname !== "string") throw new Error("Invalid preparation acknowledgement");
              assertEnvironmentTimeouts(result.environmentTimeouts);
            }
            const pending = this.pending.get(value.attemptId)!;
            this.pending.delete(value.attemptId);
            pending.resolve(value as RayResult);
          } else if (value.type === "images-cleaned") {
            const operation = typeof value.requestId === "string" ? this.maintenance.get(value.requestId) : undefined;
            if (!operation) throw new Error("Unexpected image maintenance response");
            const summary = parseImageCleanupSummary({ preview: value.preview, nodes: value.nodes });
            if (summary.preview !== operation.preview || summary.nodes.length !== operation.nodes.size || summary.nodes.some(node => !operation.nodes.has(node.nodeId))) throw new Error("Image maintenance response differs from requested nodes or mode");
            operation.waiting.resolve(summary.nodes);
            this.maintenance.delete(String(value.requestId));
          } else if (value.type === "fatal") {
            const selection = value.nodeSelection;
            if (selection && typeof selection === "object" && !Array.isArray(selection)) {
              const { requested, available } = selection as Record<string, unknown>;
              if (typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0 && typeof available === "number" && Number.isSafeInteger(available) && available >= 0)
                throw new Error(`Ray cluster has ${available} eligible execution nodes; ${requested} requested`);
            }
            if (!isErrorCode(value.code)) throw new Error("Invalid Ray failure code");
            throw new Error(`Ray driver failed (${value.code})`);
          } else if (value.type === "retired") {
            if (typeof value.attemptId !== "string" || typeof value.confirmed !== "boolean" || !this.retired.has(value.attemptId))
              throw new Error("Unexpected Ray retirement response");
            const waiting = this.retired.get(value.attemptId)!;
            this.retired.delete(value.attemptId);
            if (value.confirmed) waiting.resolve();
            else waiting.reject(new Error("Ray attempt container cleanup was not confirmed"));
          } else if (value.type === "cleaned") {
            this.cleaned.resolve();
          } else throw new Error("Ray driver protocol failed");
        }
        if (bytes.length > 2 * 1024 * 1024) throw new Error("Ray response exceeds protocol limit");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("Invalid Ray response"));
        child.kill();
      }
    });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.options.startupTimeoutMs)]);
    const abort = () => {
      this.fail(new Error("Ray driver startup cancelled or timed out"));
      child.kill();
    };
    deadline.addEventListener("abort", abort, { once: true });
    try {
      if (deadline.aborted) abort();
      // concurrency only sizes a local-mode cluster; remote clusters report slots themselves.
      this.send({
        type: "start",
        ...(this.options.imageGuard === undefined ? {} : { imageGuard: this.options.imageGuard }),
        schemaVersion: 2,
        endpoint: this.options.endpoint,
        ...(this.options.concurrency === undefined ? {} : { concurrency: this.options.concurrency }),
        ...(this.options.nodes === undefined ? {} : { nodes: this.options.nodes }),
      });
      return await this.ready.promise;
    } finally {
      deadline.removeEventListener("abort", abort);
    }
  }
  submit(job: RemoteJob): Promise<RayResult> {
    if ((this.limit !== undefined && this.pending.size >= this.limit) || this.pending.has(job.job.attemptId))
      return Promise.reject(new Error("Ray concurrency or duplicate attempt violation"));
    const pending = Promise.withResolvers<RayResult>();
    this.pending.set(job.job.attemptId, pending);
    try {
      this.send({ type: "submit", job });
    } catch (error) {
      this.pending.delete(job.job.attemptId);
      pending.reject(error);
    }
    return pending.promise;
  }
  cancel(attemptId: string, force = false): void {
    this.send({ type: "cancel", attemptId, force });
  }
  /** Only used after an acknowledged node process exit; never sweeps other attempts. */
  async cleanupAttempt(key: AttemptKey, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const waiting = Promise.withResolvers<void>();
    if (this.retired.has(key.attemptId)) throw new Error("Duplicate Ray retirement request");
    this.retired.set(key.attemptId, waiting);
    const abort = () => waiting.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.send({ type: "retire", key });
      await waiting.promise;
    } finally { signal.removeEventListener("abort", abort); }
  }
  /** Sweep leaked run containers on the selected nodes; the driver pins one cleanup per node. */
  async cleanup(runId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const abort = () => this.cleaned.reject(new Error("Ray cleanup cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.send({ type: "cleanup", runId });
      await this.cleaned.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async cleanupImages(payload: unknown, nodes: string[], signal: AbortSignal): Promise<ImageCleanupNode[]> {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    const waiting = Promise.withResolvers<ImageCleanupNode[]>();
    const request = parseImageCleanupRequest(expectRecord(payload, "image maintenance payload").request);
    this.maintenance.set(requestId, { waiting, preview: !request.execute, nodes: new Set(nodes) });
    const abort = () => { try { this.send({ type: "cancel-images", requestId }); } catch {} };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.send({ type: "cleanup-images", requestId, payload, nodes });
      const result = await waiting.promise;
      return result;
    } finally { signal.removeEventListener("abort", abort); }
  }
  async close(): Promise<void> {
    if (!this.child || this.closing) return;
    if (!this.failure) this.send({ type: "close" });
    this.closing = true;
    this.fail(new Error("Ray driver closed"));
    this.child.stdin.end();
    await Promise.race([this.exited.promise, delay(5000, undefined, { ref: false })]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await this.exited.promise;
    }
  }
}
