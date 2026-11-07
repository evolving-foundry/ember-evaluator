import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import type { DatasetRecordSource } from "../../record-source.js";
import { DatasetCache } from "../../cache.js";
import { readZipJson } from "../../input-readers/zip-json.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";

export type HttpZipJsonDefinition = { url: string; sha256: string; selections: Record<string, string> };

/** Locked HTTP bytes; each partition exposes one complete JSON document. */
export class HttpZipJsonSource implements DatasetRecordSource {
  private readonly cache: DatasetCache;
  private readonly sourceId: string;
  private readonly definitionHash: string;
  constructor(cacheDir: string, private readonly definition: HttpZipJsonDefinition, network?: import("../../../../core/contracts/network.js").NetworkAccess) {
    if (new URL(definition.url).protocol !== "https:" || !/^[a-f0-9]{64}$/.test(definition.sha256))
      throw new TypeError("HTTP ZIP data requires an HTTPS URL and SHA-256");
    this.cache = new DatasetCache(cacheDir, network);
    this.sourceId = `http-zip:${definition.url}`;
    this.definitionHash = fingerprintConfig(definition);
  }
  private assertLock(lock: SourceLock): void {
    const file = lock.files[0];
    if (lock.source !== this.sourceId || lock.revision !== this.definition.sha256 || lock.files.length !== 1 ||
      file?.path !== "dataset.zip" || file.sha256 !== this.definition.sha256 || file.origin !== this.definition.url ||
      !lock.metadata || typeof lock.metadata !== "object" || Array.isArray(lock.metadata) || lock.metadata.definitionHash !== this.definitionHash)
      throw new Error("Invalid locked HTTP ZIP source; start a new run when changing the dataset source");
  }
  async resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    if (previous) this.assertLock(previous);
    await this.cache.fetch(this.definition.url, this.definition.sha256, signal);
    return previous ? structuredClone(previous) : {
      source: this.sourceId, revision: this.definition.sha256,
      files: [{ path: "dataset.zip", origin: this.definition.url, sha256: this.definition.sha256 }],
      metadata: { definitionHash: this.definitionHash },
    };
  }
  async *rows(lock: SourceLock, selection: string, signal: AbortSignal): AsyncIterable<JsonValue> {
    this.assertLock(lock);
    const name = this.definition.selections[selection];
    if (!name) throw new TypeError(`Unknown ZIP JSON selection: ${selection}`);
    const archive = await this.cache.fetch(this.definition.url, this.definition.sha256, signal);
    yield await readZipJson(archive.path, name, signal);
  }
}
