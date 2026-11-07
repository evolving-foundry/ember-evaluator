import { resolve } from "node:path";
import { snapshotDirectory, type DirectorySnapshot } from "../../directory-snapshot.js";

export type LocalDirectorySource = { kind: "local"; path: string };

export async function materializeLocalDirectory(source: LocalDirectorySource, signal: AbortSignal): Promise<DirectorySnapshot> {
  // Keep the historical origin so existing source locks remain comparable.
  return snapshotDirectory(resolve(source.path), "urn:harbor:local", signal);
}
