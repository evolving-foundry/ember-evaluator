import { fetchNetworkResponse } from "../../network/retry.js";
import { lstat } from "node:fs/promises";
import { DatasetCache } from "../cache.js";
import { redactDiagnostic } from "../../../core/errors/diagnostics.js";

const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([1-9][0-9]*)\n?$/u;
export type GitLfsObject = { sha256: string; size: number };
type GitLfsDownload = { href: string; headers: Record<string, string> };

export function parseGitLfsPointer(bytes: Uint8Array): GitLfsObject {
  const match = LFS_POINTER.exec(Buffer.from(bytes).toString("utf8"));
  if (!match) throw new TypeError("File must be a canonical Git LFS pointer");
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError("Invalid Git LFS object size");
  return { sha256: match[1]!, size };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function lfsDownload(value: unknown, expected: GitLfsObject): GitLfsDownload {
  const response = record(value, "Git LFS batch response");
  if (response.transfer !== undefined && response.transfer !== "basic") throw new TypeError("Git LFS server did not select the basic transfer adapter");
  if (response.hash_algo !== undefined && response.hash_algo !== "sha256") throw new TypeError("Git LFS server did not select SHA-256");
  if (!Array.isArray(response.objects) || response.objects.length !== 1) throw new TypeError("Git LFS batch response must contain exactly one object");
  const object = record(response.objects[0], "Git LFS batch object");
  if (object.oid !== expected.sha256 || object.size !== expected.size) throw new TypeError("Git LFS batch object differs from its pointer");
  if (object.error !== undefined) {
    const error = record(object.error, "Git LFS object error");
    const code = typeof error.code === "number" ? ` ${error.code}` : "";
    const message = typeof error.message === "string" && error.message.trim() ? `: ${error.message}` : "";
    throw new Error(`Git LFS object download was rejected${code}${redactDiagnostic(message)}`);
  }
  const actions = record(object.actions, "Git LFS actions");
  const download = record(actions.download, "Git LFS download action");
  if (typeof download.href !== "string" || !download.href.trim()) throw new TypeError("Git LFS download href must be a non-empty string");
  const url = new URL(download.href);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError("Git LFS download href must use HTTP or HTTPS");
  const headers: Record<string, string> = {};
  if (download.header !== undefined && download.header !== null) {
    for (const [name, headerValue] of Object.entries(record(download.header, "Git LFS download headers"))) {
      if (typeof headerValue !== "string") throw new TypeError("Git LFS download header values must be strings");
      new Headers({ [name]: headerValue });
      headers[name] = headerValue;
    }
  }
  return { href: url.href, headers };
}

/** Basic Git LFS downloads backed by the framework's verified byte cache. */
export class GitLfsCache {
  constructor(private readonly cache: DatasetCache, private readonly network?: import("../../../core/contracts/network.js").NetworkAccess) {}

  async fetch(batchUrl: string, pointerBytes: Uint8Array, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const pointer = parseGitLfsPointer(pointerBytes);
    const cached = await this.cache.cached(pointer.sha256, signal);
    if (cached) return this.checkSize(cached.path, pointer, signal);
    const response = await fetchNetworkResponse(this.network?.sourceUrl(batchUrl) ?? batchUrl, {
      method: "POST",
      headers: { accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ operation: "download", transfers: ["basic"],
        objects: [{ oid: pointer.sha256, size: pointer.size }], hash_algo: "sha256" }),
      signal,
    }, { ...(this.network ? { network: this.network } : {}) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Git LFS batch HTTP ${response.status}`);
    }
    const download = lfsDownload(await response.json(), pointer);
    const object = await this.cache.fetch(download.href, pointer.sha256, signal, download.headers);
    return this.checkSize(object.path, pointer, signal);
  }

  private async checkSize(path: string, pointer: GitLfsObject, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pointer.size)
      throw new Error("Git LFS object size differs from its pointer");
    return path;
  }
}
