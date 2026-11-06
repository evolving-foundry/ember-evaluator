import { readFile } from "node:fs/promises";
import { GitBlobCache, gitBlobHash } from "./blob-cache.js";
import { parseGitTree } from "./tree.js";
import { GitLfsCache } from "../git-lfs.js";
import { evidencePath } from "../../../../core/artifacts/artifacts.js";

export type GitHubLfsSourceOptions = { repository: string; revision: string; cacheDir: string };
export type GitHubLfsTransport = { apiBase: string; lfsBase: string };

/** Resolve an ordinary GitHub repository file to its verified Git LFS object. */
export class GitHubLfsSource {
  private readonly cache: GitBlobCache;
  private readonly lfs: GitLfsCache;

  constructor(private readonly options: GitHubLfsSourceOptions, private readonly transport: GitHubLfsTransport = {
    apiBase: "https://api.github.com", lfsBase: "https://github.com",
  }, network?: import("../../../../core/contracts/network.js").NetworkAccess) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository)) throw new TypeError("Invalid GitHub repository");
    if (!options.revision.trim()) throw new TypeError("GitHub revision must not be empty");
    this.cache = new GitBlobCache(options.cacheDir, network);
    this.lfs = new GitLfsCache(this.cache.bytes, network);
  }

  async fetch(path: string, signal: AbortSignal): Promise<string> {
    const relative = evidencePath(path);
    const api = `${this.transport.apiBase}/repos/${this.options.repository}`;
    const resolved = await this.cache.bytes.fetch(`${api}/commits/${encodeURIComponent(this.options.revision)}`, null, signal);
    const value: unknown = JSON.parse(await readFile(resolved.path, "utf8"));
    if (!value || typeof value !== "object" || !("sha" in value) || typeof value.sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.sha))
      throw new TypeError("Invalid GitHub commit response");
    const object = await this.cache.bytes.fetch(`${api}/git/trees/${value.sha}?recursive=1`, null, signal);
    const tree = parseGitTree(JSON.parse(await readFile(object.path, "utf8")));
    const entry = tree.find(item => item.path === relative);
    if (!entry || entry.type !== "blob" || entry.mode !== "100644") throw new Error(`Git LFS file is absent from the locked tree: ${relative}`);
    const blob = await this.cache.bytes.fetch(`${api}/git/blobs/${entry.sha}`, null, signal);
    const data: unknown = JSON.parse(await readFile(blob.path, "utf8"));
    if (!data || typeof data !== "object" || !("encoding" in data) || data.encoding !== "base64" ||
        !("content" in data) || typeof data.content !== "string") throw new TypeError("Invalid GitHub blob response");
    const pointer = Buffer.from(data.content.replaceAll("\n", ""), "base64");
    if (gitBlobHash(pointer) !== entry.sha) throw new Error("Locked Git LFS pointer checksum mismatch");
    return this.lfs.fetch(`${this.transport.lfsBase}/${this.options.repository}.git/info/lfs/objects/batch`, pointer, signal);
  }
}
