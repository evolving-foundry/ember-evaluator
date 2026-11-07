import type { ErrorCode } from "../../../core/errors/registry.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { c as createTar } from "tar";

import type {
  CommandSpec,
  Environment,
  EnvironmentSession,
  EnvironmentSpec,
  ProcessHandle,
  RuntimeInstallation,
  RuntimeRequirement,
  RuntimeLocation,
  TransferArtifact,
  TransferSpec,
} from "../../../core/contracts/environment.js";
import type { AttemptPaths } from "../../../core/contracts/result.js";
import { startLocalProcess } from "../../../infrastructure/process/local.js";
import { findBash } from "../../../infrastructure/shell/bash.js";
import { findPowerShell, shellToolName } from "../../../infrastructure/shell/shell.js";
import { prepareLocalRuntime, runtimeCacheRoot } from "../../../infrastructure/runtime-installation/install.js";

const execFileAsync = promisify(execFile);
const PROCESS_STOP_GRACE_MS = 500;

export class LocalEnvironmentError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "LocalEnvironmentError";
  }
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function resolveRelative(root: string, value: string, label: string): string {
  if (isAbsolute(value)) throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} must be relative to the workspace`);
  const candidate = resolve(root, value);
  if (!isWithin(root, candidate)) throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} escapes the workspace`);
  return candidate;
}

async function existingWorkspacePath(workspace: string, base: string, value: string, label: string): Promise<string> {
  const candidate = resolveRelative(base, value, label);
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch (error) {
    throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} does not exist`, error);
  }
  if (!isWithin(workspace, actual))
    throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} resolves outside the workspace`);
  return actual;
}

async function createWorkspaceParent(workspace: string, candidate: string, label: string): Promise<void> {
  const parent = dirname(candidate);
  const path = relative(workspace, parent);
  if (path === "") return;
  let current = workspace;
  for (const segment of path.split(/[\\/]/u)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} crosses a symlink`);
      if (!stat.isDirectory()) throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} parent is not a directory`);
    } catch (error) {
      if (!errno(error, "ENOENT")) throw error;
      await mkdir(current);
    }
  }
}

async function writableDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
    await access(path, constants.R_OK | constants.W_OK);
    const probe = join(path, `.environment-probe-${randomUUID()}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
  } catch (error) {
    throw new LocalEnvironmentError("CONFIG_INVALID", `${label} is not writable: ${path}`, error);
  }
}

async function assertNoLinks(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new LocalEnvironmentError("TRANSFER_UNSAFE", `${label} contains a symlink`);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await assertNoLinks(join(path, entry), label);
}

function versionMatches(actual: string, expected: string): boolean {
  const wanted = expected.trim().replace(/^v/u, "");
  if (wanted === "" || wanted === "*" || wanted === "any") return true;
  const normalized = wanted.replace(/\.x$/u, "");
  return actual === normalized || actual.startsWith(`${normalized}.`);
}

function platformMatches(expected: string): boolean {
  return (
    expected === "any" ||
    expected === "*" ||
    expected === process.platform ||
    expected === `${process.platform}-${process.arch}` ||
    expected === `${process.platform}/${process.arch}`
  );
}

async function checkRuntime(
  requirement: RuntimeRequirement,
): Promise<{ name: string; version: string; executable: string }> {
  if (!platformMatches(requirement.platform)) {
    throw new LocalEnvironmentError(
      "ENV_ARCH_UNSUPPORTED",
      `${requirement.name} requires ${requirement.platform}; host is ${process.platform}/${process.arch}`,
    );
  }
  if (requirement.name === "shell") return checkRuntime({ ...requirement, name: shellToolName() });
  if (requirement.name === "powershell" && process.platform === "win32") {
    try {
      const executable = await findPowerShell();
      const { stdout } = await execFileAsync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        {
          windowsHide: true,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        },
      );
      const version = stdout.trim();
      if (!/^\d+(?:\.\d+)+$/u.test(version) || !versionMatches(version, requirement.version)) {
        throw new Error(`powershell ${requirement.version} is required; host has ${version}`);
      }
      return { name: "powershell", version, executable };
    } catch (error) {
      throw new LocalEnvironmentError(
        "ENV_RUNTIME_INSTALL_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
  if (requirement.name === "node") {
    if (!versionMatches(process.versions.node, requirement.version)) {
      throw new LocalEnvironmentError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `node ${requirement.version} is required; host has ${process.versions.node}`,
      );
    }
    return { name: "node", version: process.versions.node, executable: process.execPath };
  }
  if (requirement.name === "bash") {
    const executable = await findBash().catch(error => {
      throw new LocalEnvironmentError(
        "ENV_RUNTIME_INSTALL_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      );
    });
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(executable, ["--version"], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      }));
    } catch (error) {
      throw new LocalEnvironmentError("ENV_RUNTIME_INSTALL_FAILED", `cannot execute bash at ${executable}`, error);
    }
    const match = stdout.match(/version\s+(\d+(?:\.\d+)+)/iu);
    const version = match?.[1] ?? "unknown";
    if (!versionMatches(version, requirement.version)) {
      throw new LocalEnvironmentError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `bash ${requirement.version} is required; host has ${version}`,
      );
    }
    return { name: "bash", version, executable };
  }
  throw new LocalEnvironmentError("ENV_RUNTIME_INSTALL_FAILED", `local environment does not provide ${requirement.name}`);
}

class LocalSession implements EnvironmentSession {
  readonly id = randomUUID();
  readonly metadata;
  readonly runtime?: RuntimeLocation;
  private readonly processes = new Set<ProcessHandle>();
  private disposed = false;
  private quiesced = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly workspace: string,
    readonly workdir: string,
    readonly agentOutputDir: string,
    readonly verifierOutputDir: string,
    phase: "solve" | "verify",
    runtimes: { name: string; version: string; executable: string }[],
    runtime?: RuntimeLocation,
    private readonly defaultEnv: Record<string, string> = {},
  ) {
    if (runtime) this.runtime = runtime;
    this.metadata = {
      kind: "local",
      platform: process.platform,
      arch: process.arch,
      phase,
      runtimes,
      ...(runtime ? { installation: runtime } : {}),
    };
  }

  private active(): void {
    if (this.disposed) throw new LocalEnvironmentError("ENV_SESSION_CLOSED", "local environment session is disposed");
  }

  async start(command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    aborted(signal);
    let cwd: string;
    if (isAbsolute(command.cwd)) {
      try {
        cwd = await realpath(command.cwd);
      } catch (error) {
        throw new LocalEnvironmentError("TRANSFER_UNSAFE", "command cwd does not exist", error);
      }
      const inRuntime =
        this.runtime &&
        (isWithin(this.runtime.root, cwd) ||
          (this.runtime.stateRoot !== undefined && isWithin(this.runtime.stateRoot, cwd)));
      if (!isWithin(this.workspace, cwd) && !inRuntime) {
        throw new LocalEnvironmentError(
          "TRANSFER_UNSAFE",
          "command cwd resolves outside the workspace and admitted runtime",
        );
      }
    } else {
      cwd = await existingWorkspacePath(this.workspace, this.workspace, command.cwd, "command cwd");
    }
    const handle = await startLocalProcess(
      { ...command, cwd, env: { ...this.defaultEnv, ...command.env } },
      signal,
      command.inheritEnv === undefined ? {} : { inheritEnv: command.inheritEnv },
    );
    this.processes.add(handle);
    void handle.done.finally(() => this.processes.delete(handle)).catch(() => {});
    return handle;
  }

  async upload(source: string, target: string, signal: AbortSignal): Promise<void> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    aborted(signal);
    const verifierTarget = this.metadata.phase === "verify" && isAbsolute(target) && isWithin(this.verifierOutputDir, target)
      ? this.verifierOutputDir : null;
    const runtimeTarget = verifierTarget ?? (
      isAbsolute(target) && this.runtime?.stateRoot !== undefined && isWithin(this.runtime.stateRoot, target)
        ? this.runtime.stateRoot
        : null);
    const destination = runtimeTarget ? resolve(target) : resolveRelative(this.workdir, target, "upload target");
    const allowedRoot = runtimeTarget ?? this.workspace;
    if (!isWithin(allowedRoot, destination))
      throw new LocalEnvironmentError("TRANSFER_UNSAFE", "upload target escapes the workspace");
    await createWorkspaceParent(allowedRoot, destination, "upload target");
    const existing = await lstat(destination).catch(error => (errno(error, "ENOENT") ? null : Promise.reject(error)));
    if (existing?.isSymbolicLink()) throw new LocalEnvironmentError("TRANSFER_UNSAFE", "upload target is a symlink");
    await cp(source, destination, { recursive: true, dereference: true, force: true });
    aborted(signal);
  }

  async download(source: string, target: string, signal: AbortSignal): Promise<void> {
    this.active();
    aborted(signal);
    const actual = await existingWorkspacePath(this.workspace, this.workdir, source, "download source");
    await assertNoLinks(actual, "download source");
    const staging = await mkdtemp(join(tmpdir(), "ember-download-"));
    const staged = join(staging, "payload");
    try {
      // Preserve links while staging so a concurrent source replacement can
      // never make cp dereference host content. Only a link-free staged tree
      // is copied to the caller's target.
      await cp(actual, staged, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
      await assertNoLinks(staged, "download source");
      aborted(signal);
      await mkdir(dirname(resolve(target)), { recursive: true });
      await cp(staged, resolve(target), { recursive: true, dereference: true, force: true });
      aborted(signal);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async exportState(spec: TransferSpec, target: string, signal: AbortSignal): Promise<TransferArtifact> {
    this.active();
    aborted(signal);
    if (spec.kind !== "artifacts")
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment only exports declared artifacts");
    const base = await existingWorkspacePath(this.workspace, this.workdir, spec.workdir, "artifact workdir");
    const staging = await mkdtemp(join(tmpdir(), "ember-artifacts-"));
    const payload = join(staging, "payload");
    const temporary = join(dirname(resolve(target)), `.evaluator-artifacts-${randomUUID()}.tmp`);
    try {
      await mkdir(payload);
      const names: string[] = [];
      const required = new Set(spec.paths);
      for (const name of new Set([...spec.paths, ...(spec.optionalPaths ?? [])])) {
        aborted(signal);
        const source = resolveRelative(base, name, "artifact path");
        const info = await lstat(source).catch(error => errno(error, "ENOENT") ? null : Promise.reject(error));
        if (!info) {
          if (required.has(name)) throw new LocalEnvironmentError("ARTIFACT_COLLECTION_INCOMPLETE", `Declared artifact is missing: ${name}`);
          continue;
        }
        // download() snapshots without following links and checks the staged tree.
        await this.download(relative(this.workdir, source), join(payload, name), signal);
        names.push(name.replaceAll("\\", "/"));
      }
      const archive = join(staging, "artifacts.tar");
      await pipeline(createTar({ cwd: payload, portable: true, noMtime: true, follow: false }, names), createWriteStream(archive), { signal });
      aborted(signal);
      await mkdir(dirname(resolve(target)), { recursive: true });
      await copyFile(archive, temporary);
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(temporary, { signal })) hash.update(bytes);
      aborted(signal);
      await rename(temporary, target);
      return { path: target, sha256: hash.digest("hex"), spec };
    } finally {
      await rm(temporary, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  async restoreState(_artifact: TransferArtifact, _signal: AbortSignal): Promise<void> {
    throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment does not restore system state");
  }

  async quiesce(signal: AbortSignal): Promise<void> {
    this.active();
    this.quiesced = true;
    signal.throwIfAborted();
    await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
    signal.throwIfAborted();
  }
  async transitionToVerification(network: EnvironmentSpec["network"], signal: AbortSignal): Promise<void> {
    this.active();
    if (network === "none" || network === "model-api" || typeof network === "object")
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "Local environment cannot enforce network isolation");
    signal.throwIfAborted();
    await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
    this.metadata.phase = "verify";
  }

  dispose(_signal: AbortSignal): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS).catch(() => {})));
      await rm(this.workspace, { recursive: true, force: true });
    })();
    return this.disposal;
  }
}

export class LocalEnvironment implements Environment {
  readonly supportsRuntimeInstallation = true;
  private readonly materializedRuntimes = new WeakMap<RuntimeInstallation, { configuration: string; location: RuntimeLocation }>();
  constructor(
    private readonly temporaryRoot = tmpdir(),
    private readonly installationRoot = runtimeCacheRoot(),
    private readonly network?: import("../../../core/contracts/network.js").NetworkAccess,
  ) {}

  async materialize(spec: EnvironmentSpec, signal: AbortSignal): Promise<EnvironmentSpec> {
    aborted(signal);
    if (spec.services) throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment cannot create container services");
    if (typeof spec.network === "object")
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "Local environment cannot enforce a network allowlist");
    if (spec.image !== null || spec.build)
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment cannot build or run container images");
    for (const requirement of spec.runtime) await checkRuntime(requirement);
    const runtime = spec.installation ? await this.materializeRuntime(spec.installation, signal) : null;
    return { ...spec, prepared: { kind: "local", runtime: runtime ?? null } };
  }

  private async materializeRuntime(installation: RuntimeInstallation, signal: AbortSignal): Promise<RuntimeLocation> {
    aborted(signal);
    const configuration = JSON.stringify(installation);
    const cached = this.materializedRuntimes.get(installation);
    if (cached?.configuration === configuration) return structuredClone(cached.location);
    const location = await prepareLocalRuntime(installation, this.installationRoot, signal, this.network);
    aborted(signal);
    // Only successful shared-dependency preparation is reusable; sessions stay task-specific.
    if (JSON.stringify(installation) === configuration)
      this.materializedRuntimes.set(installation, { configuration, location: structuredClone(location) });
    return location;
  }

  /** The first install happens here; prepare() then finds the ready marker and only probes. */
  async installRuntime(installation: RuntimeInstallation, signal: AbortSignal): Promise<void> {
    aborted(signal);
    await prepareLocalRuntime(installation, this.installationRoot, signal, this.network);
  }

  async prepare(
    spec: EnvironmentSpec,
    paths: AttemptPaths,
    phase: "solve" | "verify",
    signal: AbortSignal,
  ): Promise<EnvironmentSession> {
    aborted(signal);
    if (spec.services) throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment cannot create container services");
    if (typeof spec.network === "object")
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "Local environment cannot enforce a network allowlist");
    if (spec.image !== null)
      throw new LocalEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "local environment cannot run container images");
    await Promise.all([
      writableDirectory(paths.agent, "agent output directory"),
      writableDirectory(paths.verifier, "verifier output directory"),
    ]);
    const runtimes = [];
    for (const requirement of spec.runtime) runtimes.push(await checkRuntime(requirement));
    if (phase === "verify" && spec.installation)
      throw new LocalEnvironmentError("ENV_RUNTIME_INSTALL_FAILED", "verifier environments cannot install solver runtimes");
    const prepared = spec.prepared;
    if (prepared !== undefined && (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || prepared.kind !== "local"))
      throw new LocalEnvironmentError("ENV_PREPARATION_FAILED", "Invalid local preparation receipt");
    const receipt = prepared as { runtime: RuntimeLocation | null } | undefined;
    const runtime = receipt ? receipt.runtime ?? undefined : spec.installation
      ? await prepareLocalRuntime(spec.installation, this.installationRoot, signal, this.network)
      : undefined;
    aborted(signal);

    const createdWorkspace = await mkdtemp(join(this.temporaryRoot, "ember-local-"));
    try {
      // Windows temp paths may use an 8.3 alias while realpath returns the long name.
      const workspace = await realpath(createdWorkspace);
      for (const file of spec.initialFiles) {
        aborted(signal);
        const destination = resolveRelative(workspace, file.target, "initial file target");
        await createWorkspaceParent(workspace, destination, "initial file target");
        await cp(resolve(file.source), destination, {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: true,
        });
      }
      const workdir = resolveRelative(workspace, spec.workdir, "workdir");
      await createWorkspaceParent(workspace, join(workdir, ".placeholder"), "workdir");
      await mkdir(workdir, { recursive: true });
      await access(workdir, constants.R_OK | constants.W_OK);
      aborted(signal);
      return new LocalSession(workspace, workdir, paths.agent, paths.verifier, phase, runtimes, runtime, spec.env);
    } catch (error) {
      await rm(createdWorkspace, { recursive: true, force: true });
      throw error;
    }
  }
}
