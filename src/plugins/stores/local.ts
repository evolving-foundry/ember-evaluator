import type { ErrorCode } from "../../core/errors/registry.js";
import { validFailureMetadata } from "../../core/errors/validation.js";
import { upgradeStoredResult } from "../../core/results/stored-result.js";
import { registerRunLocation } from "../../infrastructure/filesystem/run-index.js";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RunStore } from "../../core/contracts/run-store.js";
import type {
  AttemptKey,
  AttemptPaths,
  AttemptRecord,
  AttemptSummary,
  FileManifest,
  RemoteAttemptState,
  RemoteAttemptUpdate,
  ResultSnapshot,
  RunManifest,
} from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import type { MetricResults } from "../../core/contracts/metrics.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { checkedPath, verifyFileManifest } from "../../core/artifacts/artifacts.js";
import { assertAttemptRecord, trajectoryType } from "../../core/results/record-validation.js";
import { inspectReportPair } from "./report-state.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import { selectAttemptRecords } from "../../core/results/task-result-resolver.js";
import { isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { assertSourceLock } from "../../core/results/source-lock.js";
import { validateSolverProvenance } from "../../core/results/solver-provenance.js";
import { assertRunIdentity } from "../../core/results/run-identity.js";
import { assertPreparationDiagnostics, validPreparationBudget } from "../../core/preparation/preparation-validation.js";
import type { TaskReportDocument } from "../../core/contracts/reporter.js";


export class StoreError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "StoreError";
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value.endsWith("."))
    throw new StoreError("CONFIG_INVALID", "Unsafe run or attempt ID");
  return value;
}
function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function sameKey(a: AttemptKey, b: AttemptKey): boolean {
  return a.runId === b.runId && a.taskId === b.taskId && a.attemptId === b.attemptId;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errno(error, "ENOENT")) return false;
    throw error;
  }
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** The final rename is the publication point; temporary bytes are never authoritative. */
async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.evaluator-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new StoreError("STORE_WRITE_FAILED", `Cannot publish ${path}`, error);
  }
}
function serialized(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
function validateRun(run: RunManifest): void {
  safeId(run.runId);
  try {
    if (!["quality", "performance"].includes(run.evaluationKind)) throw new TypeError("Invalid evaluation kind");
    if (run.source !== null) assertSourceLock(run.source);
    else if (run.taskIds.length) throw new TypeError("Uninitialized run cannot declare tasks");
    for (const failure of [...(run.initializationFailures ?? []), ...(run.failure ? [run.failure] : [])])
      if (!failure || !validFailureMetadata(failure)) throw new TypeError("Invalid run failure evidence");
    if (run.solverProvenance !== undefined) validateSolverProvenance(run.solverProvenance);
    if (run.executionVersion !== undefined && run.executionVersion !== 2)
      throw new TypeError("Unsupported execution version");
    if (run.preparationRounds !== undefined) {
      if (!Array.isArray(run.preparationRounds)) throw new TypeError("Invalid preparation history");
      const ids = new Set<string>();
      for (const round of run.preparationRounds) {
        if (!round || typeof round.id !== "string" || ids.has(round.id) ||
          !Array.isArray(round.taskIds) || round.taskIds.some(id => !run.taskIds.includes(id)) ||
          new Set(round.taskIds).size !== round.taskIds.length ||
          !round.policy || typeof round.policy.version !== "string" || typeof round.policy.source !== "string" ||
          !validPreparationBudget(round) || !Number.isFinite(Date.parse(round.startedAt)) ||
          !["preparing", "ready", "error", "cancelled"].includes(round.status) ||
          (round.status === "preparing" ? round.finishedAt !== null :
            round.finishedAt === null || !Number.isFinite(Date.parse(round.finishedAt))) ||
          (round.error !== undefined && typeof round.error !== "string"))
          throw new TypeError("Invalid preparation round");
        ids.add(round.id);
        assertPreparationDiagnostics(round);
        if (round.placements !== undefined) {
          if (!Array.isArray(round.placements) ||
            round.placements.length > round.taskIds.length ||
            new Set(round.placements.map(item => item.taskId)).size !== round.placements.length ||
            round.placements.some(item => !round.taskIds.includes(item.taskId) || typeof item.nodeId !== "string" || !item.nodeId ||
              typeof item.digest !== "string" || !/^[a-f0-9]{64}$/u.test(item.digest)))
            throw new TypeError("Invalid preparation placement evidence");
        }
      }
    }
    if (run.identity !== undefined) assertRunIdentity(run.identity);
    if (
      run.schemaVersion !== 1 ||
      !Array.isArray(run.taskIds) ||
      run.taskIds.some(id => typeof id !== "string") ||
      new Set(run.taskIds).size !== run.taskIds.length ||
      typeof run.configFingerprint !== "string" ||
      !["running", "completed", "cancelled", "error"].includes(run.status)
    )
      throw new TypeError("Invalid run manifest fields");
    if (
      run.pluginRuntime?.patchPath !== undefined &&
      (typeof run.pluginRuntime.patchPath !== "string" || !isAbsolute(run.pluginRuntime.patchPath))
    )
      throw new TypeError("Run manifest plugin patch path must be absolute");
    if (
      run.pluginRuntime?.coordinatorPatchPath !== undefined &&
      (typeof run.pluginRuntime.coordinatorPatchPath !== "string" || run.pluginRuntime.coordinatorPatchPath.trim() === "")
    )
      throw new TypeError("Run manifest coordinator plugin patch path must be a non-empty string");
    if (
      run.pluginRuntime?.coordinatorConfigDirectory !== undefined &&
      (typeof run.pluginRuntime.coordinatorConfigDirectory !== "string" ||
        run.pluginRuntime.coordinatorConfigDirectory.trim() === "")
    )
      throw new TypeError("Run manifest coordinator config directory must be a non-empty string");
    if (run.remoteAttempts !== undefined) {
      if (!Array.isArray(run.remoteAttempts)) throw new TypeError("Invalid remote attempt diagnostics");
      const seen = new Set<string>();
      for (const item of run.remoteAttempts) {
        validateRemoteState(run, item);
        const key = JSON.stringify(item.key);
        if (seen.has(key)) throw new TypeError("Duplicate remote attempt diagnostics");
        seen.add(key);
      }
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("STORE_RECORD_INVALID", "Invalid run manifest", error);
  }
}

function validateRemoteState(run: RunManifest, item: RemoteAttemptState): void {
  if (!item || !item.key || item.key.runId !== run.runId || !run.taskIds.includes(item.key.taskId))
    throw new StoreError("STORE_RECORD_INVALID", "Remote diagnostics differ from the run selection");
  safeId(item.key.attemptId);
  if (
    !["queued", "running", "uploading", "collected", "uncollected", "quarantined"].includes(item.state) ||
    [item.nodeId, item.hostname, item.transferId, item.receipt, item.message].some(
      value => value !== null && (typeof value !== "string" || value.length > 16_384),
    )
  )
    throw new StoreError("STORE_RECORD_INVALID", "Invalid remote attempt diagnostics");
  if (item.state === "collected" && (!item.transferId || !item.receipt))
    throw new StoreError("STORE_RECORD_INVALID", "Collected state requires a transfer receipt");
}

async function reclaimDeadWriter(directory: string): Promise<void> {
  const guardPath = join(directory, ".writer-recovery.lock");
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (cause) {
    throw new StoreError("STORE_LOCKED", "Another recovery is active or recovery ownership is unknown", cause);
  }
  try {
    const path = await checkedPath(directory, ".writer.lock");
    const owner = await json<{ host?: unknown; pid?: unknown; token?: unknown }>(path);
    if (
      owner.host !== hostname() ||
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 1 ||
      typeof owner.token !== "string" ||
      !owner.token
    ) {
      throw new StoreError("STORE_LOCKED", "Writer host/PID ownership is unknown; refusing automatic recovery");
    }
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      dead = errno(error, "ESRCH");
    }
    if (!dead) throw new StoreError("STORE_LOCKED", "Writer process is alive or its state cannot be confirmed");
    // Keep the original lock as recovery evidence. Other recoverers cannot race
    // this rename; an ordinary writer cannot acquire until the old lock is gone.
    await rename(path, join(directory, `.recovered-lock-${randomUUID()}.json`));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("STORE_LOCKED", "Cannot safely recover writer ownership", error);
  } finally {
    await guard.close();
    await rm(guardPath);
  }
}

export class LocalRunStore implements RunStore {
  constructor(private readonly runIndexDirectory?: string) {}
  private directory: string | null = null;
  private run: RunManifest | null = null;
  private token: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private write<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private active(): { directory: string; run: RunManifest } {
    if (!this.directory || !this.run || !this.token)
      throw new StoreError("STORE_STATE_INVALID", "RunStore has no write lock");
    return { directory: this.directory, run: this.run };
  }
  private async lock(directory: string): Promise<void> {
    if (this.directory || this.token) throw new StoreError("STORE_STATE_INVALID", "Close the previous run first");
    if ((await lstat(directory)).isSymbolicLink()) throw new StoreError("TRANSFER_UNSAFE", "Run directory is a symlink");
    const token = randomUUID();
    let handle;
    try {
      handle = await open(join(directory, ".writer.lock"), "wx", 0o600);
    } catch (error) {
      if (!errno(error, "EEXIST")) throw new StoreError("STORE_WRITE_FAILED", "Cannot create writer lock", error);
      await reclaimDeadWriter(directory);
      try {
        handle = await open(join(directory, ".writer.lock"), "wx", 0o600);
      } catch (cause) {
        throw new StoreError("STORE_LOCKED", "Another writer acquired the recovered run", cause);
      }
    }
    try {
      await handle.writeFile(
        serialized({ host: hostname(), pid: process.pid, token, acquiredAt: new Date().toISOString() }),
      );
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(join(directory, ".writer.lock"), { force: true });
      throw error;
    }
    await handle.close();
    this.directory = directory;
    this.token = token;
  }

  get controlDirectory(): string { return this.directory ?? ""; }

  async create(root: string, manifest: RunManifest, safe: JsonValue): Promise<void> {
    return this.write(async () => {
      if (this.directory) throw new StoreError("STORE_STATE_INVALID", "Close the previous run first");
      validateRun(manifest);
      await mkdir(resolve(root), { recursive: true });
      const directory = join(await realpath(resolve(root)), safeId(manifest.runId));
      try {
        await mkdir(directory);
      } catch (error) {
        throw new StoreError("STORE_WRITE_FAILED", "Cannot create unique run directory", error);
      }
      await this.lock(directory);
      try {
        await mkdir(join(directory, "tasks"));
        // JSON syntax is valid YAML, and avoids an additional parser dependency in storage.
        await atomicWrite(join(directory, "config.yaml"), serialized(safe));
        await atomicWrite(join(directory, "manifest.json"), serialized(manifest));
        this.run = structuredClone(manifest);
        await registerRunLocation(manifest.runId, directory, this.runIndexDirectory);
      } catch (error) {
        await this.release();
        throw error;
      }
    });
  }

  async open(runDir: string): Promise<RunManifest> {
    return this.write(async () => {
      const directory = resolve(runDir);
      await this.lock(directory);
      try {
        const manifest = await json<RunManifest>(await checkedPath(directory, "manifest.json"));
        upgradeStoredResult(manifest);
        validateRun(manifest);
        this.run = manifest;
        return structuredClone(manifest);
      } catch (error) {
        await this.release();
        throw error;
      }
    });
  }

  private paths(key: AttemptKey): AttemptPaths {
    const { directory, run } = this.active();
    if (key.runId !== run.runId || !run.taskIds.includes(key.taskId))
      throw new StoreError("STORE_RECORD_INVALID", "Attempt not selected in this run");
    const root = join(directory, "tasks", safeTaskKey(key.taskId), "attempts", safeId(key.attemptId));
    return { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  }

  async allocate(key: AttemptKey): Promise<AttemptPaths> {
    return this.write(async () => {
      const paths = this.paths(key);
      const { directory } = this.active();
      const relativeParent = `tasks/${safeTaskKey(key.taskId)}/attempts`;
      await checkedPath(directory, "tasks");
      const taskDir = join(directory, "tasks", safeTaskKey(key.taskId));
      if (!(await exists(taskDir))) await mkdir(taskDir);
      await checkedPath(directory, `tasks/${safeTaskKey(key.taskId)}`);
      const parent = join(taskDir, "attempts");
      if (!(await exists(parent))) await mkdir(parent);
      await checkedPath(directory, relativeParent);
      // Ordinals belong to one task. Full-run integrity checks remain in
      // listAttempts/snapshot, rather than rescanning every scored artifact here.
      const attempts = await this.readAttempts([key.taskId]);
      const ordinal = Math.max(0, ...attempts.map(attempt => attempt.ordinal)) + 1;
      try {
        await mkdir(paths.root);
      } catch (error) {
        throw new StoreError(
          errno(error, "EEXIST") ? "STORE_CONFLICT" : "STORE_WRITE_FAILED",
          "Cannot allocate attempt directory",
          error,
        );
      }
      const allocation: AttemptSummary = {
        key: structuredClone(key),
        ordinal,
        allocatedAt: new Date().toISOString(),
        record: null,
      };
      await atomicWrite(join(paths.root, "allocation.json"), serialized(allocation));
      await Promise.all([paths.agent, paths.verifier, paths.artifacts].map(path => mkdir(path)));
      return paths;
    });
  }

  private async readAttempts(taskIds?: readonly string[]): Promise<AttemptSummary[]> {
    const { directory, run } = this.active();
    const summaries: AttemptSummary[] = [];
    for (const taskId of taskIds ?? run.taskIds) {
      const parent = `tasks/${safeTaskKey(taskId)}/attempts`;
      if (!(await exists(join(directory, parent)))) continue;
      await checkedPath(directory, parent);
      for (const attemptId of await readdir(join(directory, parent))) {
        safeId(attemptId);
        const root = await checkedPath(directory, `${parent}/${attemptId}`);
        if (!(await exists(join(root, "allocation.json")))) continue;
        const allocation = await json<AttemptSummary>(await checkedPath(root, "allocation.json"));
        if (
          allocation.key.runId !== run.runId ||
          allocation.key.taskId !== taskId ||
          allocation.key.attemptId !== attemptId ||
          !Number.isSafeInteger(allocation.ordinal) ||
          allocation.ordinal < 1
        )
          throw new StoreError("STORE_RECORD_INVALID", "Corrupt attempt allocation");
        let record: AttemptRecord | null = null;
        if (await exists(join(root, "result.json"))) {
          record = await json<AttemptRecord>(await checkedPath(root, "result.json"));
          upgradeStoredResult(record);
          assertAttemptRecord(record);
          if (
            !sameKey(record.key, allocation.key) ||
            !["completed", "agent_timeout", "failed", "cancelled"].includes(record.executionStatus)
          ) {
            throw new StoreError("STORE_RECORD_INVALID", "Result identity/status does not match allocation");
          }
          const files = await json<FileManifest>(await checkedPath(root, "files.json"));
          await verifyFileManifest(root, files);
        }
        summaries.push({ ...allocation, record });
      }
    }
    return summaries.sort(
      (a, b) => run.taskIds.indexOf(a.key.taskId) - run.taskIds.indexOf(b.key.taskId) || a.ordinal - b.ordinal,
    );
  }

  async currentTaskResult(taskId: string): Promise<AttemptRecord | null> {
    await this.queue;
    const { run } = this.active();
    if (!run.taskIds.includes(taskId)) throw new StoreError("STORE_RECORD_INVALID", "Unknown task selection");
    return selectAttemptRecords({ ...run, taskIds: [taskId] }, await this.readAttempts([taskId]))[0] ?? null;
  }

  async listAttempts(): Promise<AttemptSummary[]> {
    await this.queue;
    return this.readAttempts();
  }

  async updateRun(patch: Partial<Pick<RunManifest, "status" | "finishedAt" | "durationMs" | "preparationRounds" | "source" | "taskIds" | "failure" | "initializationFailures">>): Promise<void> {
    return this.write(async () => {
      const { directory, run } = this.active();
      if (Object.keys(patch).some(key => !["status", "finishedAt", "durationMs", "preparationRounds", "source", "taskIds", "failure", "initializationFailures"].includes(key)))
        throw new StoreError("STORE_RECORD_INVALID", "Immutable run fields cannot change");
      if (run.source !== null && (patch.source !== undefined || patch.taskIds !== undefined))
        throw new StoreError("STORE_RECORD_INVALID", "Locked source and task selection cannot change");
      if ((patch.source !== undefined) !== (patch.taskIds !== undefined))
        throw new StoreError("STORE_RECORD_INVALID", "Source and task selection must be admitted together");
      const next = { ...run, ...patch };
      validateRun(next);
      await atomicWrite(join(directory, "manifest.json"), serialized(next));
      this.run = next;
    });
  }

  async commit(record: AttemptRecord, files: FileManifest): Promise<void> {
    return this.write(() => this.publish(record, files));
  }

  private async publish(record: AttemptRecord, files: FileManifest): Promise<void> {
    assertAttemptRecord(record);
    const { directory, run } = this.active();
    if (record.evaluationKind !== run.evaluationKind)
      throw new StoreError("STORE_RECORD_INVALID", "Attempt evaluation kind differs from its run");
    const paths = this.paths(record.key);
    await checkedPath(directory, relative(directory, paths.root));
    const allocation = await json<AttemptSummary>(await checkedPath(paths.root, "allocation.json"));
    if (!sameKey(allocation.key, record.key)) throw new StoreError("STORE_RECORD_INVALID", "Mismatched allocation");
    const resultPath = join(paths.root, "result.json");
    if (await exists(resultPath)) {
      const stat = await lstat(resultPath);
      if (stat.isFile()) throw new StoreError("STORE_CONFLICT", "Cannot overwrite committed attempt");
    }
    await verifyFileManifest(paths.root, files);
    if (record.collection.trajectory === "complete") await this.checkTrajectory(paths.root, files, record.key);
    await atomicWrite(join(paths.root, "files.json"), serialized(files));
    await atomicWrite(resultPath, serialized(record));
  }

  async importAttempt(input: AttemptRecord, inventory: FileManifest, sourceRoot: string): Promise<boolean> {
    const record = structuredClone(input);
    const files = structuredClone(inventory);
    return this.write(async () => {
      assertAttemptRecord(record);
      const paths = this.paths(record.key);
      const attempts = (await this.readAttempts()).filter(item => item.key.taskId === record.key.taskId);
      const allocation = attempts.find(item => sameKey(item.key, record.key));
      if (!allocation) throw new StoreError("STORE_RECORD_INVALID", "Remote attempt was not allocated by this coordinator");
      const latest = attempts.at(-1)!;
      // Only an already completed task blocks a newer attempt's admission;
      // failed attempts are exactly what a retry attempt replaces.
      if (
        !sameKey(latest.key, record.key) ||
        attempts.some(item => item.record && isEvaluationComplete(item.record) && !sameKey(item.key, record.key))
      )
        return false;
      await verifyFileManifest(sourceRoot, files);
      if (allocation.record) {
        const saved = await json<FileManifest>(await checkedPath(paths.root, "files.json"));
        if (
          fingerprintConfig(allocation.record as unknown as JsonValue) !==
            fingerprintConfig(record as unknown as JsonValue) ||
          fingerprintConfig(saved as unknown as JsonValue) !== fingerprintConfig(files as unknown as JsonValue)
        ) {
          throw new StoreError("TRANSFER_CONFLICT", "Previously committed remote attempt differs from upload");
        }
        return true;
      }
      if (this.active().run.status !== "running") return false;
      // Stay in the same writer queue through publication. A new allocation
      // cannot overtake admission and turn this upload into a stale terminal.
      const directory = this.active().directory;
      await checkedPath(directory, relative(directory, paths.root));
      for (const entry of files.files) {
        const source = await checkedPath(sourceRoot, entry.path);
        const parts = entry.path.replaceAll("\\", "/").split("/");
        let parent = paths.root;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          try {
            await mkdir(parent);
          } catch (error) {
            if (!errno(error, "EEXIST")) throw error;
          }
          const stat = await lstat(parent);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new StoreError("TRANSFER_UNSAFE", "Imported evidence parent is unsafe");
        }
        const target = join(parent, parts.at(-1)!);
        if (await exists(target)) {
          const stat = await lstat(target);
          if (stat.isSymbolicLink() || !stat.isFile())
            throw new StoreError("TRANSFER_UNSAFE", "Imported evidence target is unsafe");
        }
        const temporary = join(paths.root, `.evaluator-${randomUUID()}.tmp`);
        try {
          await copyFile(source, temporary, constants.COPYFILE_EXCL);
          const handle = await open(temporary, "r+");
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      await this.publish(record, files);
      return true;
    });
  }

  async updateRemoteAttempt(update: RemoteAttemptUpdate): Promise<void> {
    const input = structuredClone(update);
    return this.write(async () => {
      const { directory, run } = this.active();
      const paths = this.paths(input.key);
      const allocation = await json<AttemptSummary>(await checkedPath(paths.root, "allocation.json"));
      if (!sameKey(allocation.key, input.key))
        throw new StoreError("STORE_RECORD_INVALID", "Remote diagnostics require an allocated attempt");
      const old = run.remoteAttempts?.find(item => sameKey(item.key, input.key));
      if (old && ["collected", "quarantined"].includes(old.state) && input.state !== old.state) return;
      const item: RemoteAttemptState = {
        nodeId: null,
        hostname: null,
        transferId: null,
        receipt: null,
        message: null,
        ...old,
        ...input,
      };
      validateRemoteState(run, item);
      if (item.state === "collected") {
        const committed = await json<AttemptRecord>(await checkedPath(paths.root, "result.json"));
        upgradeStoredResult(committed);
        assertAttemptRecord(committed);
        if (!sameKey(committed.key, input.key))
          throw new StoreError("STORE_RECORD_INVALID", "Collected evidence differs from attempt identity");
        await verifyFileManifest(paths.root, await json<FileManifest>(await checkedPath(paths.root, "files.json")));
      }
      if (old?.state === "collected" && (item.receipt !== old.receipt || item.transferId !== old.transferId))
        throw new StoreError("TRANSFER_CONFLICT", "Cannot replace an accepted receipt");
      const remoteAttempts = [...(run.remoteAttempts ?? []).filter(value => !sameKey(value.key, item.key)), item].sort(
        (a, b) =>
          run.taskIds.indexOf(a.key.taskId) - run.taskIds.indexOf(b.key.taskId) ||
          a.key.attemptId.localeCompare(b.key.attemptId),
      );
      const next = { ...run, remoteAttempts };
      await atomicWrite(join(directory, "manifest.json"), serialized(next));
      this.run = next;
    });
  }

  private async checkTrajectory(root: string, files: FileManifest, key: AttemptKey): Promise<void> {
    for (const required of ["agent/trajectory.jsonl", "agent/session.jsonl"]) {
      if (!files.files.some(entry => entry.path === required))
        throw new StoreError("STORE_RECORD_INVALID", `Missing ${required}`);
    }
    const contents = await readFile(await checkedPath(root, "agent/trajectory.jsonl"), "utf8");
    const lines = contents.trimEnd().split("\n");
    let seq = 1;
    let end = false;
    try {
      for (const line of lines) {
        if (end) throw new TypeError("Events after end");
        end = trajectoryType(JSON.parse(line), key, seq++) === "end";
      }
    } catch (error) {
      throw new StoreError("STORE_RECORD_INVALID", "Malformed or unrelated trajectory", error);
    }
    if (!end || !contents.endsWith("\n")) throw new StoreError("STORE_RECORD_INVALID", "Trajectory not closed");
  }

  private async readSnapshot(): Promise<ResultSnapshot> {
    const { run } = this.active();
    const attempts = await this.readAttempts();
    const records = selectAttemptRecords(run, attempts);
    const finished = new Set(records.filter(record => record.executionStatus !== "cancelled").map(record => record.key.taskId));
    const value = { run: structuredClone(run), records, attemptHistory: attempts, pendingTaskIds: run.taskIds.filter(id => !finished.has(id)) };
    return { ...value, digest: fingerprintConfig(value as unknown as JsonValue) };
  }
  async snapshot(): Promise<ResultSnapshot> {
    await this.queue;
    return this.readSnapshot();
  }

  async saveReportBundle(digest: string, metrics: MetricResults, markdown: string, documents: TaskReportDocument[], mode: "update" | "resume" = "update"): Promise<void> {
    return this.write(async () => {
      const { directory, run } = this.active();
      if ((await this.readSnapshot()).digest !== digest)
        throw new StoreError("STORE_SNAPSHOT_CHANGED", "Cannot publish a stale snapshot");
      const ids = new Set<string>(), tasks = new Set<string>();
      for (const document of documents) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(document.id) || ids.has(document.id.toLowerCase()) ||
            !run.taskIds.includes(document.taskId) || tasks.has(document.taskId) || !/^[a-f0-9]{64}$/u.test(document.snapshotDigest))
          throw new StoreError("REPORT_FAILED", "Unsafe or duplicate independent report target");
        ids.add(document.id.toLowerCase()); tasks.add(document.taskId);
      }
      const references = documents.map(({ id, taskId, title, snapshotDigest }) => ({ id, taskId, title, snapshotDigest }));
      let revision = 1;
      const documentTexts = (document: TaskReportDocument) => ({
        metrics: serialized({ schemaVersion: 1, revision, snapshotDigest: document.snapshotDigest,
          parentSnapshotDigest: digest, taskId: document.taskId, metrics: document.metrics }),
        report: `<!-- snapshotDigest: ${document.snapshotDigest} -->\n<!-- revision: ${revision} -->\n<!-- parentSnapshotDigest: ${digest} -->\n${document.markdown}\n`,
      });
      try {
        const current = await json<{ revision?: number }>(join(directory, "metrics.json"));
        // Retain existing envelope metadata when replacing a report.
        if (Number.isSafeInteger(current.revision) && current.revision !== undefined && current.revision > 0) revision = current.revision;
      } catch (error) { if (!errno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error; }
      const recovery = await inspectReportPair(directory, digest);
      if (recovery) await atomicWrite(join(directory, "report-recovery.json"), serialized(recovery));
      const metricsText = serialized({ schemaVersion: 1, revision, snapshotDigest: digest, metrics,
        ...(documents.length ? { reports: references } : {}) });
      const reportText = `<!-- snapshotDigest: ${digest} -->\n<!-- revision: ${revision} -->\n${markdown}\n`;
      const files = new Map<string, string>([["metrics.json", metricsText], ["report.md", reportText]]);
      for (const document of documents) {
        const texts = documentTexts(document);
        files.set(`points/${document.id}/metrics.json`, texts.metrics);
        files.set(`points/${document.id}/report.md`, texts.report);
      }
      // Only explicit resume creates a directory. Retries and offline rebuilds update it.
      const reports = join(directory, "reports");
      let current: string | undefined;
      if (await exists(reports)) {
        await checkedPath(directory, "reports");
        try {
          const state = await json<{ directory: unknown }>(await checkedPath(directory, "reports/current.json"));
          if (typeof state.directory !== "string" || !/^resume-[1-9]\d*$/u.test(state.directory))
            throw new StoreError("REPORT_FAILED", "Invalid current report directory");
          current = state.directory;
        } catch (error) { if (!errno(error, "ENOENT")) throw error; }
      }
      const publish = async (name: string, contents: Map<string, string>, create: boolean) => {
        const target = join(reports, name);
        const temporary = create ? join(reports, `.report-${randomUUID()}`) : target;
        await mkdir(temporary, { recursive: true });
        await checkedPath(directory, relative(directory, temporary).replaceAll("\\", "/"));
        try {
          for (const [path, text] of contents) {
            let parent = temporary;
            for (const segment of path.split("/").slice(0, -1)) {
              parent = join(parent, segment);
              await mkdir(parent, { recursive: true });
              await checkedPath(directory, relative(directory, parent).replaceAll("\\", "/"));
            }
            const relocated = path.endsWith(".md") ? text.replace(/\]\(([^)]+)\)/gu, (match, link: string) => {
              if (/^(?:[a-z][a-z\d+.-]*:|[/#])/iu.test(link)) return match;
              const target = relative(directory, resolve(directory, dirname(path), link.replace(/[?#].*$/u, ""))).replaceAll("\\", "/");
              return contents.has(target) ? match : `](../../${link})`;
            }) : text;
            await atomicWrite(join(temporary, path), relocated);
          }
          if (create) await rename(temporary, target);
        } finally { if (create) await rm(temporary, { recursive: true, force: true }); }
      };
      if (mode === "resume") {
        await mkdir(reports, { recursive: true });
        await checkedPath(directory, "reports");
        if (current === undefined && !await exists(join(reports, "initial")) && await exists(join(directory, "report.md"))) {
          const previous = new Map<string, string>();
          for (const name of ["report.md", "metrics.json"]) {
            if (await exists(join(directory, name))) previous.set(name, await readFile(await checkedPath(directory, name), "utf8"));
          }
          const saved = JSON.parse(previous.get("metrics.json") ?? "{}") as { reports?: { id: string }[] };
          for (const report of saved.reports ?? []) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(report.id)) throw new StoreError("REPORT_FAILED", "Unsafe saved report ID");
            for (const file of ["report.md", "metrics.json"]) {
              const path = `points/${report.id}/${file}`;
              if (await exists(join(directory, path))) previous.set(path, await readFile(await checkedPath(directory, path), "utf8"));
            }
          }
          await publish("initial", previous, true);
        }
        const names = (await readdir(reports)).filter(name => /^resume-[1-9]\d*$/u.test(name));
        current = `resume-${Math.max(0, ...names.map(name => Number(name.slice(7)))) + 1}`;
        await publish(current, files, true);
        await atomicWrite(join(reports, "current.json"), serialized({ directory: current }));
      } else if (current !== undefined) await publish(current, files, false);
      if (documents.length) {
        await mkdir(join(directory, "points"), { recursive: true });
        await checkedPath(directory, "points");
        for (const document of documents) {
          const target = join(directory, "points", document.id);
          await mkdir(target, { recursive: true });
          await checkedPath(directory, "points/" + document.id);
          const texts = documentTexts(document);
          await atomicWrite(join(target, "metrics.json"), texts.metrics);
          await atomicWrite(join(target, "report.md"), texts.report);
        }
      }
      await atomicWrite(join(directory, "metrics.json"), metricsText);
      await atomicWrite(join(directory, "report.md"), reportText);
      if (recovery) await atomicWrite(join(directory, "report-recovery.json"),
        serialized({ ...recovery, status: "repaired", rebuiltDigest: digest, repairedAt: new Date().toISOString() }));
    });
  }

  private async release(): Promise<void> {
    if (!this.directory || !this.token) return;
    const path = join(this.directory, ".writer.lock");
    const lock = await json<{ token: string }>(path);
    if (lock.token !== this.token)
      throw new StoreError("STORE_LOCKED", "Refusing to remove another writer's lock");
    await rm(path);
    this.directory = null;
    this.run = null;
    this.token = null;
  }
  async close(): Promise<void> {
    return this.write(() => this.release());
  }
}
