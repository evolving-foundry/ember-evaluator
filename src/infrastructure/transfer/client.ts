import { isErrorCode } from "../../core/errors/registry.js";
import { request } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { checkedPath, verifyFileManifest } from "../../core/artifacts/artifacts.js";
import { validateTransferToken } from "./https.js";
import {
  TransferError,
  transferId,
  validateReceipt,
  validateTransferPath,
  validateUploadManifest,
  type UploadManifest,
  type UploadReceipt,
} from "./protocol.js";

export type TransferClientOptions = {
  endpoint: string;
  token: string;
  ca?: string | Buffer;
  timeoutMs?: number;
  retries?: number;
};
export class TransferClient {
  private readonly endpoint: URL;
  constructor(private readonly options: TransferClientOptions) {
    this.endpoint = new URL(options.endpoint);
    validateTransferToken(options.token);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash ||
      this.endpoint.pathname !== "/"
    )
      throw new TransferError("CONFIG_INVALID", "Collector must be an HTTPS origin without credentials");
    if (
      !Number.isSafeInteger(options.retries ?? 2) ||
      (options.retries ?? 2) < 0 ||
      (options.retries ?? 2) > 10 ||
      !Number.isSafeInteger(options.timeoutMs ?? 60_000) ||
      (options.timeoutMs ?? 60_000) < 1
    )
      throw new TransferError("CONFIG_INVALID", "Invalid transfer retry or timeout budget");
  }
  private async call(
    method: string,
    path: string,
    body: () => AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 60_000)]);
        const result = Promise.withResolvers<unknown>();
        const outgoing = request(
          new URL(path, this.endpoint),
          {
            method,
            ca: this.options.ca,
            signal: requestSignal,
            headers: {
              authorization: `Bearer ${this.options.token}`,
              "content-type": method === "PUT" ? "application/octet-stream" : "application/json",
            },
          },
          response => {
            void (async () => {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of response) {
                size += chunk.length;
                if (size > 2 * 1024 * 1024)
                  throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Collector response exceeds 2 MiB");
                chunks.push(Buffer.from(chunk));
              }
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
              if (response.statusCode !== 200)
                throw new TransferError(
                  isErrorCode(value.code) ? value.code : "TRANSFER_PROTOCOL_INVALID",
                  typeof value.message === "string" ? value.message : "Collector rejected upload",
                  response.statusCode ?? 500,
                );
              return value;
            })().then(result.resolve, result.reject);
          },
        );
        outgoing.once("error", result.reject);
        const [, value] = await Promise.all([pipeline(Readable.from(body()), outgoing), result.promise]);
        return value;
      } catch (error) {
        signal.throwIfAborted();
        const retryable =
          error instanceof TransferError
            ? error.status >= 500 || error.status === 408 || error.status === 429
            : ["ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "ABORT_ERR"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              );
        if (!retryable || retry >= (this.options.retries ?? 2)) throw error;
      }
    }
  }
  async beginUpload(
    input: UploadManifest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ missingPaths: string[]; receipt: UploadReceipt | null }> {
    const manifest = validateUploadManifest(input);
    const response = (await this.call(
      "POST",
      "/v1/begin",
      async function* () {
        yield Buffer.from(JSON.stringify(manifest));
      },
      signal,
    )) as { missingPaths?: unknown; receipt?: unknown };
    if (
      !Array.isArray(response.missingPaths) ||
      response.missingPaths.some(
        path => typeof path !== "string" || !manifest.files.some(entry => entry.path === path),
      ) ||
      new Set(response.missingPaths).size !== response.missingPaths.length
    )
      throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Collector requested undeclared files");
    return {
      missingPaths: response.missingPaths as string[],
      receipt: response.receipt === null ? null : validateReceipt(response.receipt, manifest),
    };
  }
  async control(route: "runtime" | "control" | "progress", value: unknown, signal: AbortSignal): Promise<unknown> {
    return await this.call(
      "POST",
      `/v1/${route}`,
      async function* () {
        yield Buffer.from(JSON.stringify(value));
      },
      signal,
    );
  }
  async uploadFile(
    id: string,
    path: string,
    openBytes: () => AsyncIterable<Uint8Array>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    transferId(id);
    validateTransferPath(path);
    await this.call("PUT", `/v1/file/${id}?${new URLSearchParams({ path })}`, openBytes, signal);
  }
  async commitUpload(
    manifest: UploadManifest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<UploadReceipt> {
    transferId(manifest.transferId);
    return validateReceipt(
      await this.call("POST", `/v1/commit/${manifest.transferId}`, async function* () {}, signal),
      manifest,
    );
  }
  async uploadAttempt(
    input: UploadManifest,
    evidenceRoot: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<UploadReceipt> {
    const manifest = validateUploadManifest(input);
    await verifyFileManifest(evidenceRoot, { files: manifest.files, missing: manifest.missing });
    const begun = await this.beginUpload(manifest, signal);
    if (begun.receipt) return begun.receipt;
    for (const path of begun.missingPaths) {
      await this.uploadFile(
        manifest.transferId,
        path,
        async function* () {
          yield* createReadStream(await checkedPath(evidenceRoot, path));
        },
        signal,
      );
    }
    return await this.commitUpload(manifest, signal);
  }
}

/** Caller explicitly opts into deletion only after a matching accepted receipt. */
export async function removeUploadedAttempt(
  root: string,
  manifest: UploadManifest,
  receipt: UploadReceipt,
): Promise<void> {
  if (!validateReceipt(receipt, manifest).accepted)
    throw new TransferError("TRANSFER_FAILED", "Keep local files until the attempt is accepted");
  const absolute = resolve(root);
  if (basename(absolute) !== manifest.key.attemptId || (await realpath(absolute)) !== absolute)
    throw new TransferError("TRANSFER_UNSAFE", "Cleanup requires the original attempt directory");
  const allocation = JSON.parse(await readFile(await checkedPath(absolute, "allocation.json"), "utf8")) as {
    key?: Record<string, unknown>;
  };
  if (!allocation.key || Object.entries(manifest.key).some(([name, value]) => allocation.key![name] !== value))
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Local attempt identity differs from receipt");
  await verifyFileManifest(absolute, { files: manifest.files, missing: manifest.missing });
  await rm(absolute, { recursive: true, force: false });
}
