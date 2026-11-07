import { readFile } from "node:fs/promises";
import type { DataFile } from "../../../../core/contracts/task.js";
import type { GitBlobCache } from "./blob-cache.js";
import { parseGitTree, type GitTreeEntry } from "./tree.js";
import { datasetActivity } from "../../activity.js";
export type HarborRegistryTask = { name: string; repository: string; commit: string; path: string };

export const SCOPED_TREE_LAYOUT = "scoped-v1";
export type HarborTrees = { files: DataFile[]; entries: Map<string, GitTreeEntry[]> };

export function repositoryKey(task: HarborRegistryTask): string {
  return `${task.repository}@${task.commit}`;
}

function commonDirectory(tasks: readonly HarborRegistryTask[]): string[] {
  const parts = tasks[0]!.path === "" ? [] : tasks[0]!.path.split("/");
  for (const task of tasks.slice(1)) {
    const other = task.path.split("/");
    let index = 0;
    while (index < parts.length && parts[index] === other[index]) index++;
    parts.length = index;
  }
  return parts;
}

/**
 * 从 commit 逐层定位任务公共目录，避免请求与数据集无关的大型仓库目录。
 * 锁定每个实际响应；截断响应只作为分层读取的依据，其部分 entries 永不采用。
 * 已有来源锁必须恰好覆盖本次遍历，不能通过漏项或附加来源改变输入。
 */
export async function loadHarborTrees(
  tasks: readonly HarborRegistryTask[],
  cache: GitBlobCache,
  apiBase: string,
  signal: AbortSignal,
  locked?: readonly DataFile[],
): Promise<HarborTrees> {
  const expected = locked === undefined ? undefined : new Map(locked.map(file => [file.path, file]));
  if (locked && expected?.size !== locked.length) throw new Error("Duplicate locked Harbor tree path");
  const files = new Map<string, DataFile>();
  const documents = new Map<string, unknown>();

  async function read(repository: string, sha: string, recursive: boolean): Promise<unknown> {
    signal.throwIfAborted();
    const path = `trees/${repository}/${sha}.${recursive ? "recursive" : "shallow"}.json`;
    if (documents.has(path)) return documents.get(path);
    const origin = `${apiBase}/repos/${repository}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`;
    const file = expected?.get(path);
    if (expected && (!file || file.origin !== origin))
      throw new Error(`Missing or unexpected locked Harbor tree: ${path}`);
    const object = await cache.bytes.fetch(origin, file?.sha256 ?? null, signal);
    const document: unknown = JSON.parse(await readFile(object.path, "utf8"));
    files.set(path, { path, origin, sha256: object.sha256 });
    documents.set(path, document);
    return document;
  }

  async function shallow(repository: string, sha: string): Promise<GitTreeEntry[]> {
    const entries = parseGitTree(await read(repository, sha, false));
    if (entries.some(entry => entry.path.includes("/"))) throw new Error("Invalid non-recursive Harbor tree path");
    return entries;
  }

  const groups = new Map<string, HarborRegistryTask[]>();
  for (const task of tasks) {
    const key = repositoryKey(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  const trees = new Map<string, GitTreeEntry[]>();
  for (const [key, group] of groups) {
    datasetActivity(`Reading repository directory ${trees.size + 1}/${groups.size}; ${group.length} tasks`);
    const { repository, commit } = group[0]!;
    const directories = commonDirectory(group);
    let sha = commit;
    let prefix = "";
    for (const directory of directories) {
      const entry = (await shallow(repository, sha)).find(item => item.path === directory);
      if (!entry || entry.type !== "tree" || entry.mode !== "040000")
        throw new Error(`Missing Harbor task directory: ${prefix}${directory}`);
      sha = entry.sha;
      prefix += `${directory}/`;
    }
    const relevant = (path: string): boolean =>
      group.some(task => task.path === "" || path === task.path || path.startsWith(`${task.path}/`) || task.path.startsWith(`${path}/`));

    async function collect(treeSha: string, base: string, ancestors: ReadonlySet<string>): Promise<GitTreeEntry[]> {
      signal.throwIfAborted();
      if (ancestors.has(treeSha)) throw new Error("Cyclic Harbor tree");
      const value = await read(repository, treeSha, true);
      if (
        !value ||
        typeof value !== "object" ||
        !("tree" in value) ||
        !Array.isArray(value.tree) ||
        !("truncated" in value) ||
        value.truncated !== true
      ) {
        return parseGitTree(value)
          .map(entry => ({ ...entry, path: base + entry.path }))
          .filter(entry => relevant(entry.path));
      }
      const next = new Set([...ancestors, treeSha]);
      const entries: GitTreeEntry[] = [];
      for (const entry of await shallow(repository, treeSha)) {
        const path = base + entry.path;
        if (!relevant(path)) continue;
        entries.push({ ...entry, path });
        if (entry.type === "tree") {
          if (entry.mode !== "040000") throw new Error(`Invalid Harbor directory mode: ${path}`);
          entries.push(...(await collect(entry.sha, `${path}/`, next)));
        }
      }
      return entries;
    }

    trees.set(key, await collect(sha, prefix, new Set()));
    datasetActivity(`Repository directories ready ${trees.size}/${groups.size}`);
  }
  if (expected && expected.size !== files.size) throw new Error("Unexpected locked Harbor source inventory");
  return { files: [...files.values()], entries: trees };
}
