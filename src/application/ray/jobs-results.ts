import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { checkedPath, evidencePath } from "../../core/artifacts/artifacts.js";
import type { JobsClient } from "../../infrastructure/ray/jobs-client.js";

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

// Writer locks and staging temporaries are coordinator-local state; they must
// never travel with results or they would poison the next store.open/report.
function travelsWithResults(relative: string): boolean {
  return relative.split("/").every(segment => segment && !segment.startsWith("."));
}

async function digestOf(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function directoryTree(root: string, prefix = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if ((await lstat(join(root, relative))).isDirectory()) entries.push(...(await directoryTree(root, relative)));
    else entries.push(relative);
  }
  return entries;
}

/** Reconcile remote attempt diagnostics; both manifests describe the same run. */
function mergeManifests(local: unknown, staged: unknown): string {
  const run = expectRecord(staged, "result manifest");
  const previous = expectRecord(local, "existing result manifest");
  if (run.runId !== previous.runId) throw new Error("Result manifests describe different runs");
  const seen = new Set<string>();
  const remoteAttempts = [
    ...(Array.isArray(run.remoteAttempts) ? run.remoteAttempts : []),
    ...(Array.isArray(previous.remoteAttempts) ? previous.remoteAttempts : []),
  ].filter(item => {
    const key = JSON.stringify(expectRecord(item, "remote attempt")?.key ?? null);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return JSON.stringify({ ...run, ...(remoteAttempts.length ? { remoteAttempts } : {}) }, null, 2) + "\n";
}

async function mergeInto(destination: string, staging: string, log: (text: string) => void): Promise<void> {
  for (const relative of await directoryTree(staging)) {
    if (!travelsWithResults(relative)) continue;
    const source = join(staging, relative);
    const target = join(destination, relative);
    let existing = false;
    try {
      await lstat(target);
      existing = true;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (existing && (await digestOf(source)) === (await digestOf(target))) continue;
    await mkdir(dirname(target), { recursive: true });
    if (!existing) {
      await rename(source, target);
      continue;
    }
    if (relative === "manifest.json") {
      await writeFile(
        target,
        mergeManifests(JSON.parse(await readFile(target, "utf8")), JSON.parse(await readFile(source, "utf8"))),
      );
      continue;
    }
    if (["report.md", "metrics.json", "report-recovery.json", "reports/current.json"].includes(relative)) {
      await copyFile(source, target);
      continue;
    }
    // Seeded attempt metadata is rewritten host-side; anything else stays authoritative locally.
    log(`Keeping the existing local result file: ${relative}`);
  }
}

/**
 * Download a terminal job's saved run into the experiment output directory.
 * An existing directory for the same run is merged: new attempt evidence is
 * added, reports are replaced, and the run manifest unions both sides.
 */
export async function downloadRunResults(
  client: JobsClient,
  jobId: string,
  outputRoot: string,
  log: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const manifest = expectRecord(await client.call(`/jobs/${jobId}/manifest`, undefined, signal), "result manifest");
  const runId = expectNonEmptyString(manifest.runId, "runId");
  if (!/^[0-9a-f-]{36}$/u.test(runId) || !Array.isArray(manifest.files)) throw new Error("Invalid result manifest");
  const missing = Array.isArray(manifest.missing) ? manifest.missing : [];
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const destination = join(root, runId);
  let existing = false;
  try {
    await lstat(destination);
    existing = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const staging = join(root, `.download-${randomUUID()}`);
  await mkdir(staging);
  try {
    const seen = new Set<string>();
    for (const item of manifest.files) {
      const entry = expectRecord(item, "result file");
      const relative = evidencePath(expectNonEmptyString(entry.path, "file path"));
      if (seen.has(relative.toLowerCase())) throw new Error("Duplicate result file");
      seen.add(relative.toLowerCase());
      if (!travelsWithResults(relative)) continue;
      if (
        typeof entry.size !== "number" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256)
      )
        throw new Error("Invalid file digest");
      const target = join(staging, relative);
      await mkdir(dirname(target), { recursive: true });
      // Create the file even for zero-size evidence; chunks are appended below.
      await writeFile(target, new Uint8Array());
      const hash = createHash("sha256");
      let offset = 0;
      let size = 0;
      while (offset < entry.size) {
        const part = expectRecord(
          await client.call(
            `/jobs/${jobId}/file?path=${encodeURIComponent(relative)}&offset=${offset}`,
            undefined,
            signal,
          ),
          "file chunk",
        );
        const data = Buffer.from(expectNonEmptyString(part.data, "chunk data"), "base64");
        if (!data.length || data.length > entry.size - offset) throw new Error("Invalid chunk length");
        await writeFile(target, data, { flag: "a" });
        hash.update(data);
        offset += data.length;
        size += data.length;
      }
      if (size !== entry.size || hash.digest("hex") !== entry.sha256)
        throw new Error(`Result digest mismatch: ${relative}`);
    }
    if (existing) await mergeInto(destination, staging, log);
    else await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (missing.length) log(`Warning: ${missing.length} cluster result files are missing (partial evidence from unfinished tasks); downloaded the available results.`);
  return destination;
}

/** Repoint a downloaded run's offline reporter at paths available to the submitter. */
export async function localizeRunPluginRuntime(
  runDirectory: string,
  localConfigDirectory: string,
  localPatchPath: string | undefined,
): Promise<void> {
  if (!isAbsolute(localConfigDirectory)) throw new TypeError("Local experiment config directory must be absolute");
  if (localPatchPath !== undefined && !isAbsolute(localPatchPath))
    throw new TypeError("Local plugin patch path must be absolute");

  const manifestPath = join(resolve(runDirectory), "manifest.json");
  const manifest = expectRecord(JSON.parse(await readFile(manifestPath, "utf8")), "run manifest");
  const pluginRuntime = expectRecord(manifest.pluginRuntime, "plugin runtime metadata");
  const coordinatorConfigDirectory = expectNonEmptyString(
    pluginRuntime.configDirectory,
    "coordinator experiment config directory",
  );
  let changed = false;
  if (coordinatorConfigDirectory !== localConfigDirectory) {
    pluginRuntime.coordinatorConfigDirectory ??= coordinatorConfigDirectory;
    pluginRuntime.configDirectory = localConfigDirectory;
    changed = true;
  }
  if (localPatchPath !== undefined) {
    const coordinatorPatchPath = expectNonEmptyString(pluginRuntime.patchPath, "coordinator plugin patch path");
    if (coordinatorPatchPath !== localPatchPath) {
      pluginRuntime.coordinatorPatchPath ??= coordinatorPatchPath;
      pluginRuntime.patchPath = localPatchPath;
      changed = true;
    }
  }
  if (!changed) return;

  const temporary = `${manifestPath}.localizing-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Package a downloaded run for cluster-side recovery. Only store metadata
 * travels: evidence files stay on the host, and each attempt's files.json is
 * replaced by an empty inventory so store integrity checks pass without the
 * evidence bytes. New attempts never collide with seeded attempt identities.
 */
export async function buildResumeSeed(runDirectory: string): Promise<{ runId: string; seed: Record<string, string> }> {
  const manifestText = await readFile(join(runDirectory, "manifest.json"), "utf8");
  const runId = expectNonEmptyString(expectRecord(JSON.parse(manifestText), "run manifest").runId, "runId");
  const seed: Record<string, string> = { "manifest.json": manifestText };
  // Resume preserves report directories and their counter without transferring task evidence.
  for (const path of await directoryTree(runDirectory)) {
    if (travelsWithResults(path) && (["report.md", "metrics.json"].includes(path) ||
        /^(reports|points)\/.+\.(md|json)$/u.test(path)))
      seed[path] = await readFile(await checkedPath(runDirectory, path), "utf8");
  }
  let tasks: string[] = [];
  try {
    tasks = await readdir(join(runDirectory, "tasks"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  for (const taskKey of tasks) {
    let attempts: string[] = [];
    try {
      attempts = await readdir(join(runDirectory, "tasks", taskKey, "attempts"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const attemptId of attempts) {
      const base = `tasks/${taskKey}/attempts/${attemptId}`;
      for (const name of ["allocation.json", "result.json"] as const) {
        try {
          seed[`${base}/${name}`] = await readFile(join(runDirectory, base, name), "utf8");
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      if (seed[`${base}/result.json`] !== undefined)
        seed[`${base}/files.json`] = JSON.stringify({ files: [], missing: [] });
    }
  }
  return { runId, seed };
}
