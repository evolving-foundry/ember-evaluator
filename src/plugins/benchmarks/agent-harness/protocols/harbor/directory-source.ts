import type { HardwareKind } from "../../../../../core/contracts/hardware.js";
import { lstat, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Benchmark } from "../../../../../core/contracts/benchmark.js";
import type { JsonValue, SourceLock, PhaseTimeoutOverrides } from "../../../../../core/contracts/task.js";
import type { Verifier } from "../../../../../core/contracts/verifier.js";
import { buildFileManifest, checkedPath } from "../../../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../../../core/results/run-manifest.js";
import { expectRecord } from "../../../../../core/validation/input.js";
import { materializeDirectory, type DirectorySnapshot } from "../../../../../infrastructure/datasets/sources/directory.js";
import { readTomlDocument } from "./readers/task-files.js";
import type { HarborConfig } from "./config.js";
import { loadGenericHarborTask } from "./task.js";
import { datasetActivity, manifestActivity, observeDatasetSource } from "../../../../../infrastructure/datasets/activity.js";

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function createDirectoryBenchmarkSource(config: HarborConfig, verifier: Verifier, transport?: { apiBase: string; rawBase: string },
  phaseTimeouts: PhaseTimeoutOverrides = {}, hardware: HardwareKind = "npu",
  network?: import("../../../../../core/contracts/network.js").NetworkAccess): Pick<Benchmark, "resolveSource" | "enumerate" | "prepare"> {
  const snapshots = new WeakMap<SourceLock, DirectorySnapshot>();
  async function snapshot(signal: AbortSignal): Promise<DirectorySnapshot> {
    if (!config.source) throw new Error("Missing directory source");
    return materializeDirectory(config.source, config.cacheDir, signal, transport, network);
  }
  async function entries(directory: string, signal: AbortSignal) {
    const root = config.tasks.root === "." ? directory : await checkedPath(directory, config.tasks.root);
    const directories = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => compareText(a.name, b.name));
    const tasks: { id: string; path: string }[] = [];
    const seen = new Set<string>();
    const excluded: { path: string; reason: string }[] = [];
    let inspected = 0;
    for (const entry of directories) {
      signal.throwIfAborted();
      datasetActivity(`Scanning task directory ${++inspected}/${directories.length}; ${tasks.length} tasks identified`);
      const taskDir = await checkedPath(root, entry.name);
      const configPath = join(taskDir, "task.toml");
      if (!(await lstat(configPath).catch(() => null))?.isFile()) continue;
      if (config.tasks.requireTestScript && !(await lstat(join(taskDir, "tests/test.sh")).catch(() => null))?.isFile()) {
        excluded.push({ path: entry.name, reason: "Missing root shell verifier (tests/test.sh); excluded by tasks.requireTestScript" });
        continue;
      }
      const document = await readTomlDocument(configPath);
      const section = config.tasks.id === "metadata.task_id" ? document.metadata : document.task;
      const field = config.tasks.id === "metadata.task_id" ? "task_id" : "name";
      const declared = section === undefined ? undefined : expectRecord(section, "task identity")[field];
      const id = config.tasks.id === "directory" ? entry.name : declared ?? entry.name;
      if (typeof id !== "string" || !id.trim() || seen.has(id)) throw new Error(`Invalid or duplicate Harbor task ID: ${String(id)}`);
      seen.add(id);
      tasks.push({ id, path: config.tasks.root === "." ? entry.name : `${config.tasks.root}/${entry.name}` });
    }
    if (config.tasks.expectedCount !== undefined && tasks.length !== config.tasks.expectedCount)
      throw new Error(`Expected ${config.tasks.expectedCount} tasks, found ${tasks.length}`);
    return { tasks, excluded };
  }
  return observeDatasetSource({
    async resolveSource(previous, signal) {
      const current = await snapshot(signal);
      const { tasks, excluded } = await entries(current.directory, signal);
      datasetActivity(`Directory scan completed: ${tasks.length} available tasks, ${excluded.length} excluded entries`);
      const lock: SourceLock = { source: "harbor", revision: current.revision, files: current.files,
        metadata: { dataset: config.dataset, format: "directory-v1", tasks, excluded } };
      if (previous && fingerprintConfig(previous as unknown as JsonValue) !== fingerprintConfig(lock as unknown as JsonValue))
        throw new Error("Locked Harbor source differs from the configured dataset snapshot");
      snapshots.set(lock, current);
      return lock;
    },
    async *enumerate(source, signal) {
      const current = snapshots.get(source) ?? await snapshot(signal);
      if (current.revision !== source.revision) throw new Error("Harbor source changed");
      for (const task of (await entries(current.directory, signal)).tasks) yield { id: task.id, recordKey: task.path };
    },
    async prepare(ref, source, signal) {
      const current = snapshots.get(source) ?? await snapshot(signal);
      if (current.revision !== source.revision) throw new Error("Harbor source changed");
      const task = (await entries(current.directory, signal)).tasks.find(task => task.id === ref.id && task.path === ref.recordKey);
      if (!task) throw new Error("Task reference differs from the locked Harbor source");
      // Recheck task and shared grading assets against the lock immediately
      // before handing their paths to the environment or verifier.
      const taskPaths = (await entries(current.directory, signal)).tasks.map(item => item.path + "/");
      const isRelevant = (path: string) => path.startsWith(task.path + "/") || !taskPaths.some(prefix => path.startsWith(prefix));
      const relevant = source.files.filter(file => isRelevant(file.path));
      const candidates = [...new Set([task.path, ...relevant.filter(file => !file.path.startsWith(task.path + "/")).map(file => file.path.split("/")[0]!)])];
      // Shared files or excluded tasks can live beside admitted tasks. Scan each
      // root once, then apply the same selection to the locked and actual files.
      const roots = candidates.filter(root => !candidates.some(parent => root.startsWith(parent + "/")));
      const actual: { path: string; sha256: string }[] = [];
      for (const root of roots) {
        signal.throwIfAborted();
        const admitted = await checkedPath(current.directory, root);
        if ((await lstat(admitted)).isFile()) {
          actual.push({ path: root, sha256: createHash("sha256").update(await readFile(admitted)).digest("hex") });
          continue;
        }
        const inventory = await buildFileManifest(admitted, [], manifestActivity());
        datasetActivity(`Validating task and shared files: ${actual.length + inventory.files.length} files checked`);
        if (inventory.missing.length) throw new Error("Harbor source changed: unsafe task or shared assets");
        for (const file of inventory.files) {
          const path = `${root}/${file.path}`;
          if (isRelevant(path)) actual.push({ path, sha256: file.sha256 });
        }
      }
      const canonical = (files: { path: string; sha256: string }[]) => fingerprintConfig(files.sort((a, b) => compareText(a.path, b.path)) as JsonValue);
      if (canonical(actual) !== canonical(relevant.map(({ path, sha256 }) => ({ path, sha256 }))))
        throw new Error("Harbor source changed: task or shared assets differ from the source lock");
      return loadGenericHarborTask(await checkedPath(current.directory, task.path), current.directory, ref.id, config, verifier, signal, phaseTimeouts, hardware);
    },
  });
}
