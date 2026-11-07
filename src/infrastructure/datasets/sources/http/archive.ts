import * as tar from "tar";
import { DatasetCache } from "../../cache.js";
import { evidencePath } from "../../../../core/artifacts/artifacts.js";
import { restoreDirectoryModes, type DirectoryMode } from "../../../filesystem/directory-modes.js";
import { datasetActivity } from "../../activity.js";

export type HttpArchiveSource = { kind: "archive"; url: string; sha256: string; root: string };

/** Fetch pinned bytes and reject unsafe entries before extracting any archive content. */
export async function extractHttpArchive(source: HttpArchiveSource, cacheDir: string, stage: string, signal: AbortSignal, network?: import("../../../../core/contracts/network.js").NetworkAccess): Promise<void> {
  const archive = await new DatasetCache(cacheDir, network).fetch(source.url, source.sha256, signal);
  let entries = 0;
  let total = 0;
  let problem: unknown;
  const modes = new Map<string, DirectoryMode>();
  let last = -Infinity;
  datasetActivity("Checking archive entries and safety limits");
  await tar.t({ file: archive.path, strict: true, onReadEntry(entry) {
    try {
      entries++;
      if (performance.now() - last >= 200) {
        datasetActivity(`Checked ${entries} archive entries`);
        last = performance.now();
      }
      total += entry.size;
      const path = evidencePath(entry.path.replace(/\/$/u, ""));
      if (!["File", "Directory"].includes(entry.type) || entry.size > 512 * 1024 * 1024 ||
          entries > 100_000 || total > 8 * 1024 * 1024 * 1024)
        throw new Error("Unsupported or oversized dataset archive entry");
      const parts = path.split("/");
      for (let length = 1; length < parts.length; length++) {
        const parent = parts.slice(0, length).join("/");
        if (!modes.has(parent)) modes.set(parent, { path: parent, kind: "directory", mode: 0o755 });
      }
      const kind = entry.type === "Directory" ? "directory" : "file";
      modes.set(path, { path, kind, mode: typeof entry.mode === "number" ? entry.mode & 0o7777 : kind === "directory" ? 0o755 : 0o644 });
    } catch (error) { problem ??= error; }
    entry.resume();
  } });
  if (problem) throw problem;
  if (!entries) throw new Error("Empty dataset archive");
  signal.throwIfAborted();
  let extracted = 0;
  let observerFailure: { error: unknown } | undefined;
  datasetActivity(`Extracting ${entries} entries`);
  // Count consumed entries; filesystem completion is confirmed by the extraction promise.
  const extraction = tar.x({ file: archive.path, cwd: stage, strict: true, preservePaths: false, onReadEntry(entry) {
    entry.once("end", () => {
      extracted++;
      if (observerFailure === undefined && performance.now() - last >= 200) {
        try { datasetActivity(`Reading archive entries ${extracted}/${entries}`); }
        catch (error) { observerFailure = { error }; }
        last = performance.now();
      }
    });
  } });
  await extraction;
  if (observerFailure) throw observerFailure.error;
  datasetActivity(`Extraction completed ${entries}/${entries}; restoring file permissions`);
  await restoreDirectoryModes(stage, [...modes.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), signal);
}
