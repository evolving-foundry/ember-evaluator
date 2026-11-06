import { chmod, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildFileManifest, checkedPath } from "../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import type { JsonValue } from "../../../core/contracts/task.js";
import { snapshotDirectory, type DirectorySnapshot } from "../directory-snapshot.js";
import { materializeLocalDirectory, type LocalDirectorySource } from "./local/directory.js";
import { extractHttpArchive, type HttpArchiveSource } from "./http/archive.js";
import { materializeGitHubDirectory, type GitHubDirectorySource } from "./github/materialize.js";
import { readDirectoryModes, restoreDirectoryModes } from "../../filesystem/directory-modes.js";
import { datasetActivity, manifestActivity } from "../activity.js";

export type DirectorySource = (LocalDirectorySource | GitHubDirectorySource | HttpArchiveSource) & {
  hostPlatform?: "linux" | "win32" | "darwin";
};
export type { DirectorySnapshot };

async function materializationPath(value: string): Promise<string> {
  const path = resolve(value);
  try { return await realpath(path); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await materializationPath(parent), path.slice(parent.length));
  }
}

/** Transport/materialization only. Task identity and benchmark policy live in plugins. */
export async function materializeDirectory(
  source: DirectorySource,
  cacheDir: string,
  signal: AbortSignal,
  transport = { apiBase: "https://api.github.com", rawBase: "https://raw.githubusercontent.com" },
  network?: import("../../../core/contracts/network.js").NetworkAccess,
): Promise<DirectorySnapshot> {
  signal.throwIfAborted();
  if (source.hostPlatform !== undefined && source.hostPlatform !== process.platform)
    throw new Error(`Source materialization requires ${source.hostPlatform}; run the experiment in that OS. On Windows, use WSL with a Linux cache directory outside /mnt/c and /mnt/d.`);
  if (source.hostPlatform === "linux") {
    const target = await materializationPath(source.kind === "local" ? source.path : cacheDir);
    if (/^\/mnt\/[a-z](?:\/|$)/u.test(target))
      throw new Error("Linux-only sources must use a native Linux directory, outside WSL Windows drive mounts (/mnt/c, /mnt/d, etc.)");
  }
  const identity = fingerprintConfig(source as JsonValue);
  if (source.kind === "local") return materializeLocalDirectory(source, signal);
  const origin = source.kind === "archive" ? source.url : `https://github.com/${source.repository}/tree/${source.revision}`;
  const parent = join(resolve(cacheDir), "snapshots");
  await mkdir(parent, { recursive: true });
  const directory = join(parent, identity);
  const stage = await mkdtemp(join(parent, ".materialize-"));
  try {
    if (source.kind === "archive") await extractHttpArchive(source, cacheDir, stage, signal, network);
    else await materializeGitHubDirectory(source, cacheDir, stage, signal, transport, network);
    signal.throwIfAborted();
    const root = source.kind === "archive" ? source.root : source.path;
    const stagedRoot = root === "." ? stage : await checkedPath(stage, root);
    datasetActivity("Validating source snapshot");
    const stagedManifest = await buildFileManifest(stagedRoot, [], manifestActivity());
    if (stagedManifest.missing.length || !stagedManifest.files.length) throw new Error("Unsafe or empty dataset snapshot");
    await chmod(stagedRoot, 0o700);
    try { await rename(stagedRoot, directory); }
    catch (cause) {
      const existing = await buildFileManifest(directory, []);
      if (existing.missing.length || fingerprintConfig(existing.files as unknown as JsonValue) !==
          fingerprintConfig(stagedManifest.files as unknown as JsonValue))
        throw new Error("Cached dataset snapshot differs from pinned source", { cause });
      // Content equality does not imply equal permissions. Repair legacy
      // snapshots from the admitted source, keeping the cache envelope private.
      await restoreDirectoryModes(directory, await readDirectoryModes(stagedRoot, signal), signal, false);
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return snapshotDirectory(directory, origin, signal);
}
