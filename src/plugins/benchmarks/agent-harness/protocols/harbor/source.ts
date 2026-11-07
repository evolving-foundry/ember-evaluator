import type { HardwareKind } from "../../../../../core/contracts/hardware.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Benchmark } from "../../../../../core/contracts/benchmark.js";
import type { DataFile, JsonValue, SourceLock, PhaseTimeoutOverrides } from "../../../../../core/contracts/task.js";
import { canonicalJson } from "../../../../../core/results/run-manifest.js";
import { GitBlobCache } from "../../../../../infrastructure/datasets/sources/github/blob-cache.js";
import { writeGitFile } from "../../../../../infrastructure/datasets/sources/github/files.js";
import { HARBOR_REGISTRY_URL, parseHarborRegistry } from "./registry.js";
import { parseGitTree } from "../../../../../infrastructure/datasets/sources/github/tree.js";
import { loadHarborTrees, repositoryKey, SCOPED_TREE_LAYOUT, type HarborTrees } from "../../../../../infrastructure/datasets/sources/github/directories.js";
import { loadGenericHarborTask } from "./task.js";
import { HarborShellVerifier } from "../../../../verifiers/shell.js";
import type { Verifier } from "../../../../../core/contracts/verifier.js";
import { HarborTaskError } from "./compatibility.js";
import type { HarborConfig } from "./config.js";
import { expectRecord } from "../../../../../core/validation/input.js";
import { datasetActivity, observeDatasetSource } from "../../../../../infrastructure/datasets/activity.js";

export type HarborTransport = { registryUrl: string; apiBase: string; rawBase: string };
export const transportDefault: HarborTransport = {
  registryUrl: HARBOR_REGISTRY_URL,
  apiBase: "https://api.github.com",
  rawBase: "https://raw.githubusercontent.com",
};

/** Harbor registry policy composes the shared task normalizer and verifier. */
export function createHarborSource(
  config: HarborConfig,
  transport: HarborTransport = transportDefault,
  verifier: Verifier = new HarborShellVerifier(),
  phaseTimeouts: PhaseTimeoutOverrides = {},
  hardware: HardwareKind = "npu",
  network?: import("../../../../../core/contracts/network.js").NetworkAccess,
): Pick<Benchmark, "resolveSource" | "enumerate" | "prepare"> {
  const root = resolve(config.cacheDir);
  const cache = new GitBlobCache(root, network);
  const inventories = new WeakMap<SourceLock, HarborTrees>();
  const repositoryTree = (repository: string, commit: string) =>
    `${transport.apiBase}/repos/${repository}/git/trees/${commit}?recursive=1`;
  const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  function scoped(source: SourceLock): boolean {
    const metadata = expectRecord(source.metadata, "Harbor source metadata");
    if (metadata.treeLayout === undefined) return false;
    if (metadata.treeLayout !== SCOPED_TREE_LAYOUT) throw new Error("Unsupported locked Harbor tree layout");
    return true;
  }
  async function registry(source: SourceLock, signal: AbortSignal) {
    if (
      source.source !== "harbor" ||
      !source.metadata ||
      typeof source.metadata !== "object" ||
      Array.isArray(source.metadata) ||
      source.metadata.dataset !== config.dataset
    )
      throw new Error("Harbor source lock does not match dataset");
    const file = source.files.find(file => file.path === "registry.json");
    if (!file || file.origin !== transport.registryUrl || source.revision !== file.sha256)
      throw new Error("Invalid locked Harbor registry origin or revision");
    const object = await cache.bytes.fetch(file.origin, file.sha256, signal);
    return parseHarborRegistry(JSON.parse(await readFile(object.path, "utf8")), config.dataset);
  }
  return observeDatasetSource({
    async resolveSource(previous, signal) {
      datasetActivity(previous ? "Validating the locked Harbor registry and repository directories" : "Reading the Harbor dataset registry");
      if (previous) {
        const tasks = await registry(previous, signal);
        if (scoped(previous)) {
          if (previous.files.filter(file => file.path === "registry.json").length !== 1)
            throw new Error("Duplicate locked Harbor registry");
          const trees = await loadHarborTrees(
            tasks,
            cache,
            transport.apiBase,
            signal,
            previous.files.filter(file => file.path !== "registry.json"),
          );
          const source = structuredClone(previous);
          inventories.set(source, trees);
          return source;
        }
        const expected = new Map(
          tasks.map(task => [
            `trees/${task.repository}/${task.commit}.json`,
            repositoryTree(task.repository, task.commit),
          ]),
        );
        if (previous.files.length !== expected.size + 1) throw new Error("Incomplete locked Harbor source inventory");
        const seen = new Set<string>();
        for (const file of previous.files.filter(file => file.path !== "registry.json")) {
          if (seen.has(file.path) || expected.get(file.path) !== file.origin)
            throw new Error("Unexpected locked Harbor tree origin");
          seen.add(file.path);
          const object = await cache.bytes.fetch(file.origin, file.sha256, signal);
          parseGitTree(JSON.parse(await readFile(object.path, "utf8")));
        }
        if (seen.size !== expected.size) throw new Error("Incomplete locked Harbor tree inventory");
        return structuredClone(previous);
      }
      const object = await cache.bytes.fetch(transport.registryUrl, null, signal);
      const tasks = parseHarborRegistry(JSON.parse(await readFile(object.path, "utf8")), config.dataset);
      datasetActivity(`Registry contains ${tasks.length} tasks; reading repository directories`);
      const trees = await loadHarborTrees(tasks, cache, transport.apiBase, signal);
      const files: DataFile[] = [
        { path: "registry.json", origin: transport.registryUrl, sha256: object.sha256 },
        ...trees.files,
      ];
      const source: SourceLock = {
        source: "harbor",
        revision: object.sha256,
        files,
        metadata: {
          dataset: config.dataset,
          registryUrl: transport.registryUrl,
          treeLayout: SCOPED_TREE_LAYOUT,
          repositories: tasks.map(task => ({
            taskId: task.name,
            repository: task.repository,
            commit: task.commit,
            path: task.path,
          })),
        },
      };
      inventories.set(source, trees);
      return source;
    },
    async *enumerate(source, signal) {
      const tasks = await registry(source, signal);
      for (let index = 0; index < tasks.length; index++) {
        signal.throwIfAborted();
        yield { id: tasks[index]!.name, recordKey: index };
      }
    },
    async prepare(ref, source, signal) {
      const tasks = await registry(source, signal);
      const task =
        typeof ref.recordKey === "number" && Number.isSafeInteger(ref.recordKey) ? tasks[ref.recordKey] : undefined;
      if (!task || task.name !== ref.id) throw new Error("Harbor task reference differs from locked source");
      let tree;
      if (scoped(source)) {
        signal.throwIfAborted();
        const trees =
          inventories.get(source) ??
          (await loadHarborTrees(
            tasks,
            cache,
            transport.apiBase,
            signal,
            source.files.filter(file => file.path !== "registry.json"),
          ));
        inventories.set(source, trees);
        tree = trees.entries.get(repositoryKey(task));
        if (!tree) throw new Error("Missing locked Harbor task tree");
      } else {
        const treeFile = source.files.find(file => file.path === `trees/${task.repository}/${task.commit}.json`);
        if (!treeFile || treeFile.origin !== repositoryTree(task.repository, task.commit))
          throw new Error("Missing locked Harbor tree");
        const treeObject = await cache.bytes.fetch(treeFile.origin, treeFile.sha256, signal);
        tree = parseGitTree(JSON.parse(await readFile(treeObject.path, "utf8")));
      }
      const entries = tree.filter(entry => entry.path.startsWith(task.path + "/") && entry.type !== "tree");
      if (entries.some(entry => entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)))
        throw new HarborTaskError("BENCHMARK_UNSUPPORTED", "Task symlinks and submodules are unsupported");
      const preparedRoot = join(root, "prepared");
      await mkdir(preparedRoot, { recursive: true });
      const identity = createHash("sha256")
        .update(canonicalJson(task as unknown as JsonValue))
        .digest("hex");
      const directory = await mkdtemp(join(preparedRoot, identity + "-"));
      try {
        const admitted = entries.filter(entry => {
          const path = entry.path.slice(task.path.length + 1);
          return ["task.toml", "instruction.md"].includes(path) || path.startsWith("environment/") || path.startsWith("tests/");
        });
        let completed = 0;
        datasetActivity(`Preparing task files 0/${admitted.length}`);
        for (const entry of admitted) {
          const relative = entry.path.slice(task.path.length + 1);
          const origin = `${transport.rawBase}/${task.repository}/${task.commit}/${encodedPath(entry.path)}`;
          const bytes = await cache.blob(origin, entry.sha, signal);
          await writeGitFile(directory, relative, bytes, entry.mode === "100755", signal);
          datasetActivity(`Preparing task files ${++completed}/${admitted.length}`);
        }
        signal.throwIfAborted();
        return await loadGenericHarborTask(directory, directory, task.name, config, verifier, signal, phaseTimeouts, hardware);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  });
}
