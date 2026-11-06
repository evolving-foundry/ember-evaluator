import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkedPath } from "../../core/artifacts/artifacts.js";

export type DirectoryMode = { path: string; kind: "file" | "directory"; mode: number };

/** Operational metadata, separate from the persisted content/source inventory. */
export async function readDirectoryModes(root: string, signal: AbortSignal): Promise<DirectoryMode[]> {
  const entries: DirectoryMode[] = [];
  async function visit(target: string, path: string): Promise<void> {
    signal.throwIfAborted();
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error(`Unsupported entry in directory permissions: ${path}`);
    const kind = stat.isDirectory() ? "directory" : "file";
    entries.push({ path, kind, mode: stat.mode & 0o7777 });
    if (kind === "directory")
      for (const name of (await readdir(target)).sort())
        await visit(join(target, name), path === "." ? name : `${path}/${name}`);
  }
  await visit(root, ".");
  return entries;
}

/** Restore only admitted entries; children precede potentially restrictive parents. */
export async function restoreDirectoryModes(
  root: string, entries: readonly DirectoryMode[], signal: AbortSignal, includeRoot = true,
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    signal.throwIfAborted();
    if (entry.path === "." && !includeRoot) continue;
    const target = entry.path === "." ? root : await checkedPath(root, entry.path);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (entry.kind === "file" ? !stat.isFile() : !stat.isDirectory()))
      throw new Error(`Directory permission entry changed type: ${entry.path}`);
    if ((stat.mode & 0o7777) !== entry.mode) await chmod(target, entry.mode);
  }
}
