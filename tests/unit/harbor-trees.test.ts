import "../fixtures/network-fetch.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { GitBlobCache } from "../../src/infrastructure/datasets/sources/github/blob-cache.js";
import { loadHarborTrees, repositoryKey } from "../../src/infrastructure/datasets/sources/github/directories.js";
import type { GitTreeEntry } from "../../src/infrastructure/datasets/sources/github/tree.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const sha = (value: number) => String(value).repeat(40);
const entry = (path: string, value: number, type = "tree"): GitTreeEntry => ({
  path,
  sha: sha(value),
  type,
  mode: type === "tree" ? "040000" : "100644",
});
const tasks = ["a", "b"].map(name => ({
  name,
  repository: "fixture/tasks",
  commit: sha(1),
  path: `datasets/swebench/${name}`,
}));
const tree = (entries: GitTreeEntry[], truncated = false) => ({ tree: entries, truncated });

async function fixture(truncated = false) {
  await mkdir(".scratch", { recursive: true });
  const directory = await mkdtemp(".scratch/harbor-trees-");
  directories.push(directory);
  const cache = new GitBlobCache(directory);
  const base = "https://fixture.invalid/repos/fixture/tasks/git/trees/";
  const documents = new Map<string, unknown>([
    [sha(1), tree([entry("datasets", 2)])],
    [sha(2), tree([entry("swebench", 3), entry("unrelated", 9)])],
    [
      `${sha(3)}?recursive=1`,
      truncated
        ? tree([entry("a/partial-only.md", 8, "blob")], true)
        : tree([entry("a/instruction.md", 6, "blob"), entry("b/instruction.md", 7, "blob")]),
    ],
    [sha(3), tree([entry("a", 4), entry("b", 5), entry("unrelated", 9)])],
    [`${sha(4)}?recursive=1`, tree([entry("instruction.md", 6, "blob")])],
    [`${sha(5)}?recursive=1`, tree([entry("instruction.md", 7, "blob")])],
  ]);
  const fetch = vi.fn(async (url: string) => {
    const document = documents.get(url.slice(base.length));
    if (!url.startsWith(base) || !document) throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(document));
  });
  vi.stubGlobal("fetch", fetch);
  const load = (locked?: Parameters<typeof loadHarborTrees>[4]) =>
    loadHarborTrees(tasks, cache, "https://fixture.invalid", new AbortController().signal, locked);
  return { fetch, load };
}

test("reads only the dataset subtree and resumes the exact source lock without network", async () => {
  const { fetch, load } = await fixture();
  const result = await load();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result.entries.get(repositoryKey(tasks[0]!))?.map(item => item.path)).toEqual([
    "datasets/swebench/a/instruction.md",
    "datasets/swebench/b/instruction.md",
  ]);
  fetch.mockClear();
  fetch.mockRejectedValue(new Error("Network must not be used"));
  expect(await load(result.files)).toEqual(result);
  expect(fetch).not.toHaveBeenCalled();
});

test("discards truncated entries and fetches complete relevant child trees", async () => {
  const { fetch, load } = await fixture(true);
  const result = await load();
  expect(fetch).toHaveBeenCalledTimes(6);
  const paths = result.entries.get(repositoryKey(tasks[0]!))?.map(item => item.path);
  expect(paths).toEqual([
    "datasets/swebench/a",
    "datasets/swebench/a/instruction.md",
    "datasets/swebench/b",
    "datasets/swebench/b/instruction.md",
  ]);
  expect(await load(result.files)).toEqual(result);
});

test("rejects missing, extra, duplicate and redirected source lock entries", async () => {
  const { load } = await fixture();
  const { files } = await load();
  await expect(load(files.slice(1))).rejects.toThrow("Missing or unexpected locked Harbor tree");
  await expect(load([...files, { ...files[0]!, path: "extra.json" }])).rejects.toThrow(
    "Unexpected locked Harbor source inventory",
  );
  await expect(load([...files, files[0]!])).rejects.toThrow("Duplicate locked Harbor tree path");
  await expect(load(files.map(file => ({ ...file, origin: "https://unexpected.invalid" })))).rejects.toThrow(
    "Missing or unexpected locked Harbor tree",
  );
});
