import type { NetworkAccess } from "../../../../core/contracts/network.js";
import { fetchNetworkResponse } from "../../../network/retry.js";
import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import { DatasetCache } from "../../cache.js";
import { datasetActivity } from "../../activity.js";
import { huggingfaceTransport, type HuggingFaceTransport } from "./endpoint.js";
import { readRows } from "../../input-readers/rows.js";
import { redactDiagnostic } from "../../../../core/errors/diagnostics.js";

export type HuggingFaceDefinition = { dataset: string; subset: string; split: string; revision: string };

export class HuggingFaceSource {
  private readonly cache: DatasetCache;
  private readonly transport: HuggingFaceTransport;
  constructor(
    cacheDir: string,
    private readonly definition: HuggingFaceDefinition,
    transport?: HuggingFaceTransport,
    private readonly network?: NetworkAccess,
  ) {
    this.cache = new DatasetCache(cacheDir, network);
    this.transport = transport ?? huggingfaceTransport(undefined, network);
  }
  private get sourceId(): string {
    return `huggingface:${this.definition.dataset}:${this.definition.subset}:${this.definition.split}`;
  }
  private origin(revision: string, path: string): string {
    return `${this.transport.fileBase}/datasets/${this.definition.dataset}/resolve/${encodeURIComponent(revision)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  }
  private assertLock(lock: SourceLock): void {
    const { subset, split } = this.definition;
    if (lock.source !== this.sourceId || !/^[a-f0-9]{40}$/.test(lock.revision) || !lock.files.length)
      throw new Error("Invalid locked dataset source");
    const names = new Set<string>();
    for (const file of lock.files) {
      if (
        !file.path.startsWith(`${subset}/${split}-`) ||
        !/^[a-zA-Z0-9_/.-]+\.parquet$/.test(file.path) ||
        file.path.split("/").some(part => part === "." || part === "..") ||
        names.has(file.path) ||
        file.origin !== this.origin(lock.revision, file.path)
      )
        throw new Error("Invalid locked dataset file origin");
      this.cache.objectPath(file.sha256);
      names.add(file.path);
    }
  }

  async resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    datasetActivity(previous ? "Validating locked Hugging Face data files" : "Querying the Hugging Face revision and file list");
    signal.throwIfAborted();
    if (previous !== null) {
      this.assertLock(previous);
      for (const file of previous.files) await this.cache.fetch(file.origin, file.sha256, signal);
      return structuredClone(previous);
    }
    const { dataset, subset, split, revision } = this.definition;
    const url = `${this.transport.apiBase}/api/datasets/${dataset}/revision/${encodeURIComponent(revision)}?blobs=true`;
    let data: { sha?: unknown; siblings?: unknown };
    try {
      const response = await fetchNetworkResponse(url, { signal }, { ...(this.network ? { network: this.network } : {}) });
      if (!response.ok) throw new Error(`Hugging Face metadata HTTP ${response.status}`);
      data = (await response.json()) as { sha?: unknown; siblings?: unknown };
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new Error(`Hugging Face metadata request failed: ${redactDiagnostic(url)}`, { cause });
    }
    if (typeof data.sha !== "string" || !/^[a-f0-9]{40}$/.test(data.sha) || !Array.isArray(data.siblings))
      throw new Error("Invalid Hugging Face metadata");
    const candidates = data.siblings.filter(
      (file): file is { rfilename: string; lfs?: { sha256?: string } } =>
        file !== null &&
        typeof file === "object" &&
        "rfilename" in file &&
        typeof file.rfilename === "string" &&
        file.rfilename.startsWith(`${subset}/${split}-`) &&
        file.rfilename.endsWith(".parquet"),
    );
    if (!candidates.length) throw new Error("Dataset split has no Parquet files");
    const lock: SourceLock = {
      source: this.sourceId,
      revision: data.sha,
      files: [],
      metadata: { dataset, subset, split, format: "parquet" },
    };
    for (const candidate of candidates.sort((a, b) => a.rfilename.localeCompare(b.rfilename))) {
      datasetActivity(`Preparing data file ${lock.files.length + 1}/${candidates.length}`);
      if (candidate.rfilename.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("Unsafe dataset path");
      const origin = this.origin(lock.revision, candidate.rfilename);
      const file = await this.cache.fetch(origin, candidate.lfs?.sha256 ?? null, signal);
      lock.files.push({ path: candidate.rfilename, sha256: file.sha256, origin });
    }
    this.assertLock(lock);
    return lock;
  }

  async *rows(lock: SourceLock, signal: AbortSignal): AsyncIterable<JsonValue> {
    this.assertLock(lock);
    for (const file of lock.files) {
      const cached = await this.cache.fetch(file.origin, file.sha256, signal);
      for await (const row of readRows(cached.path, "parquet")) {
        signal.throwIfAborted();
        yield row;
      }
    }
  }
}
