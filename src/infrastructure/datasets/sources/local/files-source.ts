import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import { checkedPath, evidencePath, inspectFile } from "../../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import type { DatasetFileSource, SnapshotSelection } from "../huggingface/snapshot-source.js";
import type { DatasetRecordSource } from "../../record-source.js";
import type { DatasetFilesDefinition } from "../huggingface/files-source.js";
import { readRows } from "../../input-readers/rows.js";
import { datasetActivity } from "../../activity.js";

const matches = (path: string, selection: SnapshotSelection) => "path" in selection
  ? path === selection.path : path.startsWith(selection.prefix) && path.endsWith(selection.suffix);

/** Local release files keep their upstream layout; their content, not a remote revision, is locked. */
export class LocalFileSource implements DatasetFileSource {
  private readonly path: string;
  private readonly definitionHash: string;
  constructor(path: string, private readonly definition: { dataset: string; selections: readonly SnapshotSelection[] }) {
    this.path = resolve(path);
    for (const selection of definition.selections) evidencePath("path" in selection ? selection.path : `${selection.prefix}file${selection.suffix}`);
    this.definitionHash = fingerprintConfig({ dataset: definition.dataset, selections: definition.selections.map(selection => ({ ...selection })) });
  }

  private async inventory(signal: AbortSignal): Promise<{ root: string; files: { logical: string; physical: string }[] }> {
    signal.throwIfAborted();
    const info = await lstat(this.path);
    if (info.isSymbolicLink()) throw new Error(`Local dataset cannot be a symlink: ${this.path}`);
    if (info.isFile()) {
      const selection = this.definition.selections[0];
      if (this.definition.selections.length !== 1 || !selection)
        throw new Error("This dataset requires multiple file selections; localPath must point to a directory with the original layout");
      const logical = "path" in selection ? selection.path : `${selection.prefix}local${selection.suffix}`;
      return { root: dirname(this.path), files: [{ logical, physical: basename(this.path) }] };
    }
    if (!info.isDirectory()) throw new Error(`Local dataset is not a regular file or directory: ${this.path}`);
    const files: { logical: string; physical: string }[] = [];
    const scan = async (prefix: string): Promise<void> => {
      signal.throwIfAborted();
      for (const entry of await readdir(join(this.path, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Metadata caches are not part of a downloaded release's dataset files.
        if (entry.name === ".git" || entry.name === ".cache") continue;
        if (entry.isDirectory()) await scan(path);
        else if (this.definition.selections.some(selection => matches(path, selection))) {
          if (!entry.isFile()) throw new Error(`Local dataset requires regular files, not links: ${path}`);
          files.push({ logical: path, physical: path });
        }
      }
    };
    await scan("");
    for (const selection of this.definition.selections) {
      if (!files.some(file => matches(file.logical, selection)))
        throw new Error(`Local dataset ${this.path} is missing ${"path" in selection ? selection.path : selection.prefix + "*" + selection.suffix}`);
    }
    return { root: this.path, files: files.sort((a, b) => a.logical.localeCompare(b.logical, "en")) };
  }

  async resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    const inventory = await this.inventory(signal);
    const files: SourceLock["files"] = [];
    for (const file of inventory.files) {
      signal.throwIfAborted();
      datasetActivity(`Checking local dataset file ${files.length + 1}/${inventory.files.length}: ${file.logical}`);
      const entry = await inspectFile(inventory.root, file.physical);
      const handle = await open(await checkedPath(inventory.root, file.physical), "r");
      try {
        const header = Buffer.alloc(64);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/u.test(header.toString("utf8", 0, bytesRead)))
          throw new Error(`Local dataset file is a Git LFS pointer: ${file.logical}; download the LFS objects before using localPath`);
      } finally { await handle.close(); }
      files.push({ path: file.logical, sha256: entry.sha256, origin: pathToFileURL(join(inventory.root, file.physical)).href });
    }
    const lock: SourceLock = { source: `local:${this.definition.dataset}`, revision: `local:${fingerprintConfig(files)}`, files,
      metadata: { dataset: this.definition.dataset, definitionHash: this.definitionHash } };
    if (previous && fingerprintConfig(previous) !== fingerprintConfig(lock))
      throw new Error("Local dataset changed or differs from the source lock; restore the original files or start a new run");
    return lock;
  }

  async file(lock: SourceLock, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    evidencePath(path);
    if (lock.source !== `local:${this.definition.dataset}` || !lock.metadata || typeof lock.metadata !== "object" ||
      Array.isArray(lock.metadata) || lock.metadata.definitionHash !== this.definitionHash ||
      lock.revision !== `local:${fingerprintConfig(lock.files)}`) throw new Error("Invalid local dataset source lock");
    const file = lock.files.find(file => file.path === path);
    if (!file || !this.definition.selections.some(selection => matches(path, selection))) throw new Error(`File is absent from local dataset: ${path}`);
    const info = await lstat(this.path);
    const root = info.isFile() ? dirname(this.path) : this.path;
    const physical = info.isFile() ? basename(this.path) : path;
    const target = await checkedPath(root, physical);
    if (file.origin !== pathToFileURL(target).href || (await inspectFile(root, physical)).sha256 !== file.sha256)
      throw new Error(`Local dataset file changed: ${path}`);
    return target;
  }
}

export class LocalRecordSource implements DatasetRecordSource {
  readonly files: LocalFileSource;
  constructor(path: string, private readonly definition: DatasetFilesDefinition) {
    this.files = new LocalFileSource(path, { dataset: definition.dataset, selections: definition.selections.map(selection =>
      selection.path !== undefined ? { path: selection.path } : { prefix: selection.prefix ?? "", suffix: `.${selection.format}` }) });
  }
  resolve(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> { return this.files.resolve(previous, signal); }
  async *rows(lock: SourceLock, key: string, signal: AbortSignal): AsyncIterable<JsonValue> {
    const selection = this.definition.selections.find(selection => selection.key === key);
    if (!selection) throw new Error(`Unknown local dataset selection: ${key}`);
    for (const file of lock.files.filter(file => selection.path !== undefined ? file.path === selection.path
      : file.path.startsWith(selection.prefix ?? "") && file.path.endsWith(`.${selection.format}`))) {
      for await (const row of readRows(await this.files.file(lock, file.path, signal), selection.format)) {
        signal.throwIfAborted();
        yield row;
      }
    }
  }
}
