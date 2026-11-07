import type { NetworkAccess } from "../../../../core/contracts/network.js";
import { fetchNetworkResponse } from "../../../network/retry.js";
import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import { redactDiagnostic } from "../../../../core/errors/diagnostics.js";
import { DatasetCache } from "../../cache.js";
import { datasetActivity } from "../../activity.js";
import { readRows } from "../../input-readers/rows.js";
import { huggingfaceTransport } from "./endpoint.js";
import type { HuggingFaceTransport } from "./endpoint.js";
import type { DatasetRecordSource } from "../../record-source.js";
import { hubFileUrl, safeHubPath } from "./file-path.js";

export type DatasetFileSelection = {
  key: string;
  format: "parquet" | "jsonl" | "csv";
  path?: string;
  prefix?: string;
};

export type DatasetFilesDefinition = {
  dataset: string;
  revision: string;
  selections: readonly DatasetFileSelection[];
};

type HubSibling = { rfilename: string; lfs?: { sha256?: string } };

function matching(path: string, selection: DatasetFileSelection): boolean {
  const suffix = `.${selection.format}`;
  return selection.path === undefined
    ? selection.prefix !== undefined && path.startsWith(selection.prefix) && path.endsWith(suffix)
    : path === selection.path;
}

/** Loads explicitly selected Hub files and pins both the commit and downloaded bytes. */
export class HuggingFaceFilesSource implements DatasetRecordSource {
  private readonly cache: DatasetCache;
  private readonly transport: HuggingFaceTransport;
  private readonly definitionHash: string;
  private readonly headers: Record<string, string> | undefined;
  private readonly sourceId: string;

  constructor(
    cacheDir: string,
    name: string,
    private readonly definition: DatasetFilesDefinition,
    token?: string,
    transport?: HuggingFaceTransport,
    private readonly network?: NetworkAccess,
  ) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(definition.dataset) ||
      !definition.selections.length ||
      new Set(definition.selections.map(item => item.key)).size !== definition.selections.length ||
      definition.selections.some(
        item =>
          !item.key ||
          (item.path === undefined) === (item.prefix === undefined) ||
          (item.path !== undefined && !safeHubPath(item.path)) ||
          (item.prefix !== undefined && !safeHubPath(`${item.prefix}x`)),
      )
    ) {
      throw new TypeError("Invalid Hugging Face file selection");
    }
    this.cache = new DatasetCache(cacheDir, network);
    this.transport = transport ?? huggingfaceTransport(undefined, network);
    this.definitionHash = fingerprintConfig(definition as unknown as JsonValue);
    this.headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    this.sourceId = `huggingface:${name}:${definition.dataset}`;
  }

  private origin(revision: string, path: string): string {
    return hubFileUrl(this.transport.fileBase, this.definition.dataset, revision, path);
  }

  private selected(path: string): DatasetFileSelection | null {
    const matches = this.definition.selections.filter(selection => matching(path, selection));
    if (matches.length > 1) throw new TypeError(`Overlapping Hugging Face file selections: ${path}`);
    return matches[0] ?? null;
  }

  private assertLock(lock: SourceLock): void {
    if (
      lock.source !== this.sourceId ||
      !/^[a-f0-9]{40}$/.test(lock.revision) ||
      !lock.metadata ||
      typeof lock.metadata !== "object" ||
      Array.isArray(lock.metadata) ||
      lock.metadata.definitionHash !== this.definitionHash ||
      !lock.files.length
    ) {
      throw new Error("Invalid locked Hugging Face source");
    }
    const paths = new Set<string>();
    for (const file of lock.files) {
      if (
        !safeHubPath(file.path) ||
        !this.selected(file.path) ||
        paths.has(file.path) ||
        file.origin !== this.origin(lock.revision, file.path)
      )
        throw new Error("Invalid locked Hugging Face file");
      this.cache.objectPath(file.sha256);
      paths.add(file.path);
    }
    for (const selection of this.definition.selections) {
      if (!lock.files.some(file => matching(file.path, selection)))
        throw new Error(`Missing locked Hugging Face files: ${selection.key}`);
    }
  }

  async resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    datasetActivity(previous ? "Validating locked Hugging Face data files" : "Querying the Hugging Face revision and file list");
    signal.throwIfAborted();
    if (previous !== null) {
      this.assertLock(previous);
      for (const file of previous.files) await this.cache.fetch(file.origin, file.sha256, signal, this.headers);
      return structuredClone(previous);
    }
    const url = `${this.transport.apiBase}/api/datasets/${this.definition.dataset}/revision/${encodeURIComponent(this.definition.revision)}?blobs=true`;
    let data: { sha?: unknown; siblings?: unknown };
    try {
      const response = await fetchNetworkResponse(url, { signal, ...(this.headers === undefined ? {} : { headers: this.headers }) }, { ...(this.network ? { network: this.network } : {}) });
      if (!response.ok)
        throw new Error(
          response.status === 401 || response.status === 403
            ? `Hugging Face dataset ${this.definition.dataset} access denied (HTTP ${response.status}); check dataset access and HF token environment variable`
            : `Hub metadata HTTP ${response.status}`,
        );
      data = (await response.json()) as { sha?: unknown; siblings?: unknown };
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new Error(
        `Hugging Face metadata request failed: ${redactDiagnostic(url)} (${redactDiagnostic(cause instanceof Error ? cause.message : String(cause))})`,
        { cause },
      );
    }
    if (typeof data.sha !== "string" || !/^[a-f0-9]{40}$/.test(data.sha) || !Array.isArray(data.siblings)) {
      throw new Error("Invalid Hugging Face metadata");
    }
    const candidates: HubSibling[] = data.siblings.filter(
      (item): item is HubSibling =>
        item !== null &&
        typeof item === "object" &&
        "rfilename" in item &&
        typeof item.rfilename === "string" &&
        this.selected(item.rfilename) !== null,
    );
    for (const selection of this.definition.selections) {
      if (!candidates.some(file => matching(file.rfilename, selection)))
        throw new Error(`Dataset selection has no files: ${selection.key}`);
    }
    const lock: SourceLock = {
      source: this.sourceId,
      revision: data.sha,
      files: [],
      metadata: {
        dataset: this.definition.dataset,
        definitionHash: this.definitionHash,
        selections: this.definition.selections.map(item => ({ ...item })),
      },
    };
    for (const candidate of candidates.sort((a, b) => a.rfilename.localeCompare(b.rfilename))) {
      datasetActivity(`Preparing data file ${lock.files.length + 1}/${candidates.length}`);
      if (!safeHubPath(candidate.rfilename)) throw new Error("Unsafe dataset path");
      const origin = this.origin(lock.revision, candidate.rfilename);
      const file = await this.cache.fetch(origin, candidate.lfs?.sha256 ?? null, signal, this.headers);
      lock.files.push({ path: candidate.rfilename, sha256: file.sha256, origin });
    }
    this.assertLock(lock);
    return lock;
  }

  async *rows(lock: SourceLock, key: string, signal: AbortSignal): AsyncIterable<JsonValue> {
    this.assertLock(lock);
    const selection = this.definition.selections.find(item => item.key === key);
    if (!selection) throw new TypeError(`Unknown Hugging Face selection: ${key}`);
    for (const file of lock.files.filter(item => matching(item.path, selection))) {
      const cached = await this.cache.fetch(file.origin, file.sha256, signal, this.headers);
      for await (const row of readRows(cached.path, selection.format)) {
        signal.throwIfAborted();
        yield row;
      }
    }
  }
}
