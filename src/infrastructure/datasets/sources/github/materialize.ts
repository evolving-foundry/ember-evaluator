import { GitBlobCache } from "./blob-cache.js";
import { loadHarborTrees, repositoryKey } from "./directories.js";
import { writeGitFile } from "./files.js";
import { evidencePath } from "../../../../core/artifacts/artifacts.js";
import { datasetActivity } from "../../activity.js";

export type GitHubDirectorySource = { kind: "github"; repository: string; revision: string; path: string; exclude?: string[] };
export type GitHubDirectoryTransport = { apiBase: string; rawBase: string };

/** Materialize only admitted Git blobs, preserving modes and checking Git object digests. */
export async function materializeGitHubDirectory(
  source: GitHubDirectorySource, cacheDir: string, stage: string, signal: AbortSignal, transport: GitHubDirectoryTransport, network?: import("../../../../core/contracts/network.js").NetworkAccess,
): Promise<void> {
  const cache = new GitBlobCache(cacheDir, network);
  const descriptor = { name: "source", repository: source.repository, commit: source.revision, path: source.path === "." ? "" : source.path };
  const trees = await loadHarborTrees([descriptor], cache, transport.apiBase, signal);
  const entries = trees.entries.get(repositoryKey(descriptor));
  if (!entries) throw new Error("Missing dataset tree");
  const excluded = source.exclude?.map(path => evidencePath(path)) ?? [];
  const blobs = entries.filter(entry => entry.type !== "tree" &&
    !excluded.some(path => entry.path === path || entry.path.startsWith(path + "/")));
  const failure = new AbortController();
  const active = AbortSignal.any([signal, failure.signal]);
  const objects = new Map<string, Promise<Uint8Array>>();
  let cursor = 0;
  let completed = 0;
  datasetActivity(`Preparing source files 0/${blobs.length}`);
  const downloads = await Promise.allSettled(Array.from({ length: Math.min(8, blobs.length) }, async () => {
    try {
      while (cursor < blobs.length) {
        const entry = blobs[cursor++]!;
        active.throwIfAborted();
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
          throw new Error(`Unsupported dataset link or submodule: ${entry.path}`);
        const relative = evidencePath(entry.path);
        const url = `${transport.rawBase}/${source.repository}/${source.revision}/${relative.split("/").map(encodeURIComponent).join("/")}`;
        let object = objects.get(entry.sha);
        if (!object) { object = cache.blob(url, entry.sha, active); objects.set(entry.sha, object); }
        const bytes = await object;
        await writeGitFile(stage, relative, bytes, entry.mode === "100755", active);
        datasetActivity(`Preparing source files ${++completed}/${blobs.length}`);
      }
    } catch (error) { failure.abort(error); throw error; }
  }));
  const failed = downloads.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
