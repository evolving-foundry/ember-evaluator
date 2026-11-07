import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { FileEntry, FileManifest } from "../contracts/result.js";

const metadata = new Set(["allocation.json", "result.json", "files.json"]);
const inventoryFailure = "inventory read failed";
const inventorySentinel = ".evaluator-inventory-error";

function inventoryFailureReason(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${inventoryFailure}${code}`;
}
function pathStateErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function evidencePathState(root: string, path: string): Promise<"absent" | "unreadable" | "present"> {
  try {
    await lstat(resolve(root, evidencePath(path)));
    return "present";
  } catch (error) {
    return pathStateErrorCode(error) === "ENOENT" ? "absent" : "unreadable";
  }
}
export function safeTaskKey(taskId: string): string {
  return createHash("sha256").update(taskId).digest("hex");
}
export function evidencePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path))
    throw new Error("Unsafe evidence path");
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some(part => !part || part === "." || part === ".." || part.includes(":")))
    throw new Error("Unsafe evidence path");
  return normalized;
}

/** Reject directory junctions as well as file symlinks before accessing evidence. */
export async function checkedPath(root: string, path: string): Promise<string> {
  const base = resolve(root);
  const normalized = evidencePath(path);
  const target = resolve(base, normalized);
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Unsafe evidence path");
  let current = base;
  if ((await lstat(current)).isSymbolicLink()) throw new Error("Evidence root cannot be a symlink");
  for (const part of normalized.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink evidence rejected: ${normalized}`);
  }
  return target;
}

export async function inspectFile(root: string, path: string): Promise<FileEntry> {
  const normalized = evidencePath(path);
  const target = await checkedPath(root, normalized);
  const before = await lstat(target);
  if (!before.isFile()) throw new Error(`Evidence is not a regular file: ${normalized}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(target)) {
    hash.update(bytes);
    size += bytes.length;
  }
  const after = await lstat(target);
  if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error(`Evidence changed during checksum: ${normalized}`);
  return { path: normalized, size, sha256: hash.digest("hex") };
}

export async function buildFileManifest(root: string, expected: string[], onFile?: (count: number) => void): Promise<FileManifest> {
  const required = [...new Set(expected.map(evidencePath))];
  const result: FileManifest = { files: [], missing: [] };
  const recordFailure = (path: string, error: unknown) => {
    if (!result.missing.some(entry => entry.path === path))
      result.missing.push({ path, reason: inventoryFailureReason(error) });
  };
  async function walk(directory: string, prefix: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(directory)).sort();
    } catch (error) {
      recordFailure(prefix || inventorySentinel, error);
      return;
    }
    for (const name of names) {
      if (!prefix && (metadata.has(name) || /^\.evaluator-.*\.tmp$/.test(name))) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      let stat;
      try {
        stat = await lstat(join(directory, name));
      } catch (error) {
        recordFailure(path, error);
        continue;
      }
      if (stat.isSymbolicLink()) result.missing.push({ path, reason: "symlink evidence is not followed" });
      else if (stat.isDirectory()) await walk(join(directory, name), path);
      else if (stat.isFile()) {
        try {
          result.files.push(await inspectFile(root, path));
        } catch (error) {
          recordFailure(path, error);
        }
        onFile?.(result.files.length);
      } else result.missing.push({ path, reason: "not a regular file" });
    }
  }
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    recordFailure(inventorySentinel, error);
  }
  if (rootStat?.isSymbolicLink()) throw new Error("Evidence root cannot be a symlink");
  if (rootStat) await walk(root, "");
  const recorded = new Set([...result.files, ...result.missing].map(entry => entry.path));
  for (const path of required)
    if (!recorded.has(path)) result.missing.push({ path, reason: "not produced or not collected" });
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  result.missing.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export async function verifyFileManifest(root: string, manifest: FileManifest): Promise<void> {
  const seen = new Set<string>();
  const inventory = await buildFileManifest(
    root,
    manifest.missing.map(entry => entry.path),
  );
  const actualFiles = new Map(inventory.files.map(entry => [entry.path, entry]));
  const actualMissing = new Map(inventory.missing.map(entry => [entry.path, entry]));
  for (const entry of manifest.files) {
    const path = evidencePath(entry.path);
    if (metadata.has(path) || seen.has(path)) throw new Error(`Invalid or duplicate inventory path: ${path}`);
    seen.add(path);
    const actual = actualFiles.get(path);
    if (!actual || actual.size !== entry.size || actual.sha256 !== entry.sha256)
      throw new Error(`Evidence checksum changed: ${path}`);
  }
  for (const entry of manifest.missing) {
    const path = evidencePath(entry.path);
    const actual = actualMissing.get(path);
    if (seen.has(path) || !entry.reason || actualFiles.has(path) || !actual)
      throw new Error(`Invalid missing inventory entry: ${path}`);
    if (
      entry.reason.startsWith(inventoryFailure) &&
      !actual.reason.startsWith(inventoryFailure) &&
      (await evidencePathState(root, path)) === "present"
    ) {
      throw new Error(`Evidence became readable before commit: ${path}`);
    }
    seen.add(path);
  }
  for (const entry of [...inventory.files, ...inventory.missing]) {
    if (!seen.has(entry.path)) throw new Error(`Unlisted evidence in inventory: ${entry.path}`);
  }
}
