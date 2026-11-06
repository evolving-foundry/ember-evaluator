import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatasetCache } from "../../cache.js";

export function gitBlobHash(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export class GitBlobCache {
  readonly bytes: DatasetCache;
  constructor(private readonly directory: string, network?: import("../../../../core/contracts/network.js").NetworkAccess) {
    this.bytes = new DatasetCache(directory, network);
  }

  async blob(url: string, gitSha: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new TypeError("Invalid Git blob digest");
    const mappings = join(this.directory, "git-blobs");
    const mapping = join(mappings, gitSha);
    try {
      const sha = (await readFile(mapping, "utf8")).trim();
      if (/^[a-f0-9]{64}$/.test(sha)) {
        const cached = await readFile(this.bytes.objectPath(sha));
        if (gitBlobHash(cached) === gitSha && createHash("sha256").update(cached).digest("hex") === sha) return cached;
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const object = await this.bytes.fetch(url, null, signal);
    const bytes = await readFile(object.path);
    if (gitBlobHash(bytes) !== gitSha) throw new Error("Locked Git blob checksum mismatch");
    signal.throwIfAborted();
    await mkdir(mappings, { recursive: true });
    const temporary = join(mappings, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(object.sha256 + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, mapping);
    } finally {
      await rm(temporary, { force: true });
    }
    return bytes;
  }
}
