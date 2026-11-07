import "../fixtures/network-fetch.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parseGitTree } from "../../src/infrastructure/datasets/sources/github/tree.js";
import { GitBlobCache } from "../../src/infrastructure/datasets/sources/github/blob-cache.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("Tree parsing rejects incomplete inventories and unsafe identities", () => {
  const entry = { path: "tasks/example/task.toml", type: "blob", mode: "100644", sha: "a".repeat(40) };
  expect(parseGitTree({ truncated: false, tree: [entry] })).toEqual([entry]);
  for (const value of [
    { truncated: true, tree: [entry] },
    { tree: [entry] },
    { truncated: false, tree: [entry, entry] },
    { truncated: false, tree: [{ ...entry, path: "../outside" }] },
    { truncated: false, tree: [{ ...entry, sha: "invalid" }] },
  ]) expect(() => parseGitTree(value)).toThrow();
});

test("blob cache validates both digests, repairs corruption and honors cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-blob-cache-"));
  roots.push(root);
  const bytes = Buffer.from("fixture content\n");
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const url = "https://example.test/locked-file";
  const cache = new GitBlobCache(root);
  expect(Buffer.from(await cache.blob(url, sha, signal))).toEqual(bytes);
  expect(Buffer.from(await cache.blob(url, sha, signal))).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(1);
  const digest = (await readFile(join(root, "git-blobs", sha), "utf8")).trim();
  await writeFile(cache.bytes.objectPath(digest), "corrupted");
  // Start a fresh acquisition after corrupting the on-disk object.
  expect(Buffer.from(await cache.blob(url, sha, new AbortController().signal))).toEqual(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
  await expect(cache.blob(url, "b".repeat(40), new AbortController().signal)).rejects.toThrow("checksum mismatch");
  const calls = fetch.mock.calls.length;
  await expect(cache.blob(url, sha, AbortSignal.abort())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(calls);
});
