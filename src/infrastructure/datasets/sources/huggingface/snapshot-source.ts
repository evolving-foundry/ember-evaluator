import type { NetworkAccess } from "../../../../core/contracts/network.js";
import { fetchNetworkResponse } from "../../../network/retry.js";
import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import { redactDiagnostic } from "../../../../core/errors/diagnostics.js";
import { DatasetCache } from "../../cache.js";
import { datasetActivity } from "../../activity.js";
import { huggingfaceTransport, type HuggingFaceTransport } from "./endpoint.js";
import { hubFileUrl, safeHubPath } from "./file-path.js";

export type SnapshotSelection = { path: string } | { prefix: string; suffix: string };
export type HuggingFaceSnapshotDefinition = { dataset: string; revision: string; selections: readonly SnapshotSelection[] };
export interface DatasetFileSource {
  resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock>;
  file(lock: SourceLock, path: string, signal: AbortSignal): Promise<string>;
}

function matches(path: string, selection: SnapshotSelection): boolean {
  return "path" in selection ? path === selection.path : path.startsWith(selection.prefix) && path.endsWith(selection.suffix);
}

/** Pin arbitrary Hub file bytes without interpreting their benchmark contents. */
export class HuggingFaceSnapshotSource implements DatasetFileSource {
  private readonly cache: DatasetCache;
  private readonly transport: HuggingFaceTransport;
  private readonly headers: Record<string, string> | undefined;
  private readonly definitionHash: string;
  private readonly sourceId: string;

  constructor(cacheDir: string, private readonly definition: HuggingFaceSnapshotDefinition,
    token?: string, transport?: HuggingFaceTransport, private readonly network?: NetworkAccess) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(definition.dataset) || !definition.revision ||
      !definition.selections.length || definition.selections.some(selection => "path" in selection
        ? !safeHubPath(selection.path) : !safeHubPath(`${selection.prefix}x`) || !/^\.[A-Za-z0-9]+$/u.test(selection.suffix)))
      throw new TypeError("Invalid Hugging Face snapshot selection");
    this.cache = new DatasetCache(cacheDir, network);
    this.transport = transport ?? huggingfaceTransport(undefined, network);
    this.headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    this.definitionHash = fingerprintConfig(definition as unknown as JsonValue);
    this.sourceId = `huggingface-snapshot:${definition.dataset}`;
  }

  private origin(revision: string, path: string): string {
    return hubFileUrl(this.transport.fileBase, this.definition.dataset, revision, path);
  }

  private assertLock(lock: SourceLock): void {
    const metadata = lock.metadata;
    if (lock.source !== this.sourceId || !/^[a-f0-9]{40}$/u.test(lock.revision) ||
      (/^[a-f0-9]{40}$/u.test(this.definition.revision) && lock.revision !== this.definition.revision) ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.definitionHash !== this.definitionHash || !lock.files.length)
      throw new Error("Invalid locked Hugging Face snapshot");
    const paths = new Set<string>();
    for (const file of lock.files) {
      if (!safeHubPath(file.path) || paths.has(file.path) ||
        this.definition.selections.filter(selection => matches(file.path, selection)).length !== 1 ||
        file.origin !== this.origin(lock.revision, file.path)) throw new Error("Invalid locked Hugging Face snapshot file");
      this.cache.objectPath(file.sha256);
      paths.add(file.path);
    }
    for (const selection of this.definition.selections)
      if (!lock.files.some(file => matches(file.path, selection))) throw new Error("Missing locked Hugging Face snapshot files");
  }

  async resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    if (previous !== null) {
      this.assertLock(previous);
      for (const file of previous.files) await this.cache.fetch(file.origin, file.sha256, signal, this.headers);
      return structuredClone(previous);
    }
    datasetActivity("Querying the Hugging Face document snapshot");
    const url = `${this.transport.apiBase}/api/datasets/${this.definition.dataset}/revision/${encodeURIComponent(this.definition.revision)}?blobs=true`;
    let data: unknown;
    try {
      const response = await fetchNetworkResponse(url, { signal, ...(this.headers ? { headers: this.headers } : {}) }, { ...(this.network ? { network: this.network } : {}) });
      if (!response.ok) throw new Error([401, 403].includes(response.status)
        ? `Hugging Face dataset ${this.definition.dataset} access denied (HTTP ${response.status}); check dataset access and HF token environment variable`
        : `Hub metadata HTTP ${response.status}`);
      data = await response.json();
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error(`Hugging Face metadata request failed: ${redactDiagnostic(url)} (${redactDiagnostic(cause instanceof Error ? cause.message : String(cause))})`, { cause });
    }
    if (!data || typeof data !== "object" || !("sha" in data) || typeof data.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(data.sha) || !("siblings" in data) || !Array.isArray(data.siblings))
      throw new Error("Invalid Hugging Face snapshot metadata");
    if (/^[a-f0-9]{40}$/u.test(this.definition.revision) && data.sha !== this.definition.revision)
      throw new Error("Hugging Face revision differs from requested commit");
    const lock: SourceLock = { source: this.sourceId, revision: data.sha, files: [],
      metadata: { dataset: this.definition.dataset, definitionHash: this.definitionHash } };
    const candidates: { path: string; digest: string | null }[] = [];
    const siblings: unknown[] = data.siblings;
    for (const item of siblings) {
      if (!item || typeof item !== "object" || !("rfilename" in item) || typeof item.rfilename !== "string")
        throw new Error("Invalid Hugging Face file metadata");
      const path = item.rfilename;
      const selected = this.definition.selections.filter(selection => matches(path, selection));
      if (!selected.length) continue;
      if (selected.length !== 1 || !safeHubPath(item.rfilename)) throw new Error("Unsafe or overlapping Hugging Face snapshot path");
      const lfs: unknown = "lfs" in item ? item.lfs : undefined;
      let digest: string | null = null;
      if (lfs !== undefined) {
        if (!lfs || typeof lfs !== "object" || !("sha256" in lfs) || typeof lfs.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(lfs.sha256))
          throw new Error("Invalid Hugging Face LFS digest");
        digest = lfs.sha256;
      }
      candidates.push({ path: item.rfilename, digest });
    }
    if (new Set(candidates.map(file => file.path)).size !== candidates.length ||
      this.definition.selections.some(selection => !candidates.some(file => matches(file.path, selection))))
      throw new Error("Missing or duplicate Hugging Face snapshot files");
    for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path, "en"))) {
      datasetActivity(`Preparing document file ${lock.files.length + 1}/${candidates.length}`);
      const origin = this.origin(lock.revision, candidate.path);
      // Hub LFS metadata already pins the bytes. Fetch them lazily in file(), so
      // task enumeration need not download a multi-gigabyte document corpus.
      const digest = candidate.digest ?? (await this.cache.fetch(origin, null, signal, this.headers)).sha256;
      lock.files.push({ path: candidate.path, sha256: digest, origin });
    }
    this.assertLock(lock);
    return lock;
  }

  async file(lock: SourceLock, path: string, signal: AbortSignal): Promise<string> {
    this.assertLock(lock);
    const file = lock.files.find(item => item.path === path);
    if (!file) throw new Error(`File is absent from locked Hugging Face snapshot: ${path}`);
    return (await this.cache.fetch(file.origin, file.sha256, signal, this.headers)).path;
  }
}
