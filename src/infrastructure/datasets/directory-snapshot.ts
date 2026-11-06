import type { DataFile, JsonValue } from "../../core/contracts/task.js";
import { buildFileManifest } from "../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { datasetActivity, manifestActivity } from "./activity.js";

export type DirectorySnapshot = { directory: string; files: DataFile[]; revision: string };

/** Identical inventory rules for local directories and materialized remote sources. */
export async function snapshotDirectory(directory: string, origin: string, signal: AbortSignal): Promise<DirectorySnapshot> {
  signal.throwIfAborted();
  datasetActivity("Scanning the source directory and computing file digests");
  const inventory = await buildFileManifest(directory, [], manifestActivity());
  if (inventory.missing.length || !inventory.files.length) throw new Error("Unsafe or unreadable dataset snapshot");
  const files = inventory.files.map(file => ({ path: file.path, sha256: file.sha256, origin: `${origin}#${file.path}` }));
  datasetActivity(`Source digests completed: ${files.length} files`);
  return { directory, files, revision: fingerprintConfig(files.map(({ path, sha256 }) => ({ path, sha256 })) as JsonValue) };
}
