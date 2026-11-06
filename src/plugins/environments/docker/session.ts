import { DockerEnvironmentError } from "../../../infrastructure/containers/error.js";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { removeDockerContainer, stopDockerContainer } from "../../../infrastructure/containers/cleanup.js";
import { captureDockerLogOwnership, makeDockerLogsWritable, restoreDockerLogOwnership } from "../../../infrastructure/containers/log-ownership.js";
import { dockerExecutionOwner, ownDockerRuntimeUpload, type DockerExecutionOwner } from "../../../infrastructure/containers/runtime-upload.js";
import type { ContainerPlatform, CommandSpec, EnvironmentSession, EnvironmentSpec, ModelEndpointMapping, ProcessHandle, RuntimeLocation, TransferArtifact, TransferSpec } from "../../../core/contracts/environment.js";
import { validateNetworkPolicy } from "../../../core/policies/network-policy.js";
import { EGRESS_PROXY_ENV } from "../../../infrastructure/network/egress-proxy.js";
import { startDockerProcess } from "../../../infrastructure/containers/process.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand, type PreparedRuntimeImage } from "../../../infrastructure/containers/runtime-contract.js";
import { type PlatformResolution } from "../../../infrastructure/containers/platform.js";
import { DockerComposeProject } from "../../../infrastructure/containers/compose.js";
import { validateTransferSpec } from "../../../infrastructure/filesystem/workspace-transfer.js";
import { exportGitPatch, restoreGitPatch } from "../shared/git-patch.js";
import { startModelForwarder, type GatewayHandle } from "../../../infrastructure/network/model-gateway.js";
import { exportWorkspace, restoreWorkspace } from "../../../infrastructure/filesystem/workspace-transfer.js";
import { assertLinkFree, containerTarget, containerFileTarget } from "./paths.js";

const PROCESS_STOP_GRACE_MS = 500;
export type DockerMetadata = {
  executionUsers?: NonNullable<EnvironmentSpec["executionUsers"]>;
  kind: "docker";
  phase: "solve" | "verify";
  platform: ContainerPlatform;
  platformResolution: PlatformResolution;
  containerId: string;
  services?: { project: string; containers: Record<string, string> };
  baseImage: { reference: string; id: string };
  derivedImage: { reference: string; id: string };
  installation?: RuntimeLocation;
  modelEndpoint?: {
    baseUrl: string;
    originEndpoint: string;
    gateway?: { containerId: string; image: string; volume: string };
  };
  runtimes: PreparedRuntimeImage["runtimes"];
  resources: {
    requested: { cpus: number | null; memory: string | null; storage: string | null };
    effective: { cpus: number | null; memoryBytes: number | null; storage: { enforced: false }; cpusetCpus?: string; availableCpus?: number };
  };
};

type DockerDownloadCleanup = {
  containerId: string;
  token: string;
  staging: string;
  snapshotAttempted: boolean;
  restoreStoppedState: boolean;
};

type DockerDownloadOutcome = { ok: true } | { ok: false; error: unknown };

export async function completeDockerDownload(
  command: DockerCommand,
  cleanup: DockerDownloadCleanup,
  outcome: DockerDownloadOutcome,
): Promise<void> {
  const failures: unknown[] = [];
  if (cleanup.snapshotAttempted) {
    try {
      await command(["exec", cleanup.containerId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "remove-snapshot", cleanup.token], {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (cleanup.restoreStoppedState) {
    try {
      await command(["stop", "--time", "0", cleanup.containerId], { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(cleanup.staging, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    const errors = outcome.ok ? failures : [outcome.error, ...failures];
    throw new DockerEnvironmentError(
      "CLEANUP_FAILED",
      `Docker container ${cleanup.containerId} download cleanup failed`,
      new AggregateError(errors),
      cleanup.containerId,
    );
  }
  if (!outcome.ok) throw outcome.error;
}

export class DockerSession implements EnvironmentSession {
  readonly metadata: DockerMetadata;
  readonly runtime?: RuntimeLocation;
  readonly modelEndpoint?: ModelEndpointMapping;
  private readonly processes = new Set<ProcessHandle>();
  private readonly starting = new Set<Promise<ProcessHandle>>();
  private readonly gateway?: GatewayHandle;
  private processEnv: Record<string, string> = {};
  private runtimeUploadOwner: { user: string | undefined; owner: DockerExecutionOwner } | undefined;
  private disposed = false;
  private quiesced = false;
  private disposal: Promise<void> | null = null;
  constructor(
    readonly id: string,
    readonly workdir: string,
    readonly agentOutputDir: string,
    readonly verifierOutputDir: string,
    private readonly dockerExecutable: string,
    private readonly command: DockerCommand,
    metadata: DockerMetadata,
    private readonly logOwners: Awaited<ReturnType<typeof captureDockerLogOwnership>>,
    gateway?: GatewayHandle,
    private readonly project?: DockerComposeProject,
  ) {
    this.metadata = metadata;
    if (metadata.installation) this.runtime = metadata.installation;
    if (metadata.modelEndpoint) {
      this.modelEndpoint = {
        baseUrl: metadata.modelEndpoint.baseUrl,
        originEndpoint: metadata.modelEndpoint.originEndpoint,
      };
    }
    if (gateway) this.gateway = gateway;
  }
  private active(): void {
    if (this.disposed) throw new DockerEnvironmentError("ENV_SESSION_CLOSED", `Docker session ${this.id} is disposed`);
  }
  async start(command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    signal.throwIfAborted();
    const runtimeRoots = this.runtime
      ? [this.runtime.stateRoot, this.runtime.root].filter((root): root is string => root !== undefined)
      : [];
    const cwd = containerTarget(this.workdir, command.cwd, runtimeRoots).target;
    const pending = startDockerProcess(
      { dockerExecutable: this.dockerExecutable, containerId: this.id, command: this.command },
      { ...command, cwd, env: { ...command.env, ...this.processEnv },
        ...(this.metadata.executionUsers?.[this.metadata.phase] === undefined ? {} : { user: this.metadata.executionUsers[this.metadata.phase] }) },
      signal,
    );
    this.starting.add(pending);
    let handle: ProcessHandle;
    try { handle = await pending; } finally { this.starting.delete(pending); }
    if (this.quiesced) {
      await handle.stop(PROCESS_STOP_GRACE_MS);
      throw new Error("Session quiesced while a process was starting");
    }
    this.processes.add(handle);
    void handle.done.finally(() => this.processes.delete(handle)).catch(() => {});
    return handle;
  }
  async upload(source: string, target: string, signal: AbortSignal): Promise<void> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    signal.throwIfAborted();
    const requested = resolve(source);
    await assertLinkFree(requested, "upload source");
    const actual = await realpath(requested);
    const sourceStat = await lstat(actual);
    const privateRoot = ["/tests", "/environment", "/logs/verifier"].find(root => target === root || target.startsWith(root + "/"));
    const privateTarget = this.metadata.phase === "verify" ? privateRoot : undefined;
    const writableRuntimeRoots = this.runtime?.stateRoot === undefined ? [] : [this.runtime.stateRoot];
    const destination = privateTarget
      ? { root: privateTarget, target: posix.normalize(target) }
      : containerFileTarget(this.workdir, target, writableRuntimeRoots);
    if (privateTarget && destination.target !== privateRoot && !destination.target.startsWith(privateRoot + "/"))
      throw new DockerEnvironmentError("TRANSFER_UNSAFE", "private upload escapes /tests");
    const runtimeUpload = this.metadata.phase === "solve" && destination.root === this.runtime?.stateRoot;
    let owner: DockerExecutionOwner | undefined;
    if (runtimeUpload) {
      if (destination.target === destination.root)
        throw new DockerEnvironmentError("TRANSFER_UNSAFE", "runtime upload must be beneath the state root");
      const user = this.metadata.executionUsers?.solve;
      if (!this.runtimeUploadOwner || this.runtimeUploadOwner.user !== user)
        this.runtimeUploadOwner = { user, owner: await dockerExecutionOwner(this.command, this.id, user, signal) };
      owner = this.runtimeUploadOwner.owner;
      await ownDockerRuntimeUpload(this.command, this.id, "prepare", destination.root, destination.target, sourceStat.isDirectory(), owner, signal);
    } else await this.command(
      [
        "exec",
        this.id,
        EVALUATOR_NODE_EXECUTABLE,
        PROCESS_HELPER,
        "mkdir",
        destination.root,
        destination.target,
        sourceStat.isDirectory() ? "directory" : "file",
      ],
      { signal },
    );
    const dockerSource = sourceStat.isDirectory() ? `${actual}${sep}.` : actual;
    await this.command(["cp", dockerSource, `${this.id}:${destination.target}`], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (owner)
      await ownDockerRuntimeUpload(this.command, this.id, "complete", destination.root, destination.target, sourceStat.isDirectory(), owner, signal);
    signal.throwIfAborted();
  }
  async download(source: string, target: string, signal: AbortSignal): Promise<void> {
    this.active();
    signal.throwIfAborted();
    const allowed = containerFileTarget(this.workdir, source,
      this.metadata.phase === "verify" ? ["/logs/verifier", "/tests"] : [this.agentOutputDir]);
    const origin = allowed.target;
    const state = JSON.parse(
      (await this.command(["inspect", this.id, "--format", "{{json .State}}"], { signal })).stdout,
    ) as { Running?: boolean; Paused?: boolean };
    if (state.Paused)
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", `cannot download from paused container ${this.id}`);
    const staging = await mkdtemp(join(tmpdir(), "ember-docker-download-"));
    const payload = join(staging, "payload");
    const token = randomUUID();
    let snapshotAttempted = false;
    let restoreStoppedState = false;
    let outcome: DockerDownloadOutcome = { ok: true };
    try {
      if (state.Running !== true) {
        restoreStoppedState = true;
        await this.project?.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
      snapshotAttempted = true;
      await this.command(["exec", this.id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "snapshot", token, allowed.root, origin], {
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      await this.command(["cp", `${this.id}:/opt/evaluator/downloads/${token}/payload`, payload], {
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      await assertLinkFree(payload, "download source");
      signal.throwIfAborted();
      const destination = resolve(target);
      await mkdir(dirname(destination), { recursive: true });
      await cp(payload, destination, { recursive: true, dereference: true, force: true });
      signal.throwIfAborted();
    } catch (error) {
      outcome = { ok: false, error };
    }
    await completeDockerDownload(
      this.command,
      { containerId: this.id, token, staging, snapshotAttempted, restoreStoppedState },
      outcome,
    );
  }
  async exportState(spec: TransferSpec, target: string, signal: AbortSignal): Promise<TransferArtifact> {
    this.active();
    signal.throwIfAborted();
    if (spec.kind === "artifacts" && spec.services) {
      validateTransferSpec(spec, this.workdir);
      if (!this.project) throw new Error("Service artifacts require a multi-container environment");
    }
    const state = JSON.parse(
      (await this.command(["inspect", this.id, "--format", "{{json .State}}"], { signal })).stdout,
    ) as { Running?: boolean; Paused?: boolean };
    if (state.Paused)
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", `cannot export from paused container ${this.id}`);
    const restoreStoppedState = state.Running !== true;
    let exportFailure: unknown;
    try {
      // As with download(), restart the managed idle process for the snapshot;
      // solver exec processes are not restarted with the container.
      if (restoreStoppedState) {
        await this.project?.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
      if (spec.kind === "artifacts" && spec.services && this.project) await this.project.snapshotArtifacts(this.id, spec, signal);
      if (spec.kind === "git-patch")
        return await exportGitPatch({ id: this.id, workdir: this.workdir, command: this.command }, spec, target, signal);
      return await exportWorkspace({ id: this.id, workdir: this.workdir, command: this.command }, spec, target, signal);
    } catch (error) {
      exportFailure = error;
      throw error;
    } finally {
      if (restoreStoppedState) {
        try {
          await this.command(["stop", "--time", "0", this.id], { signal: AbortSignal.timeout(5_000) });
        } catch (error) {
          throw new DockerEnvironmentError(
            "CLEANUP_FAILED",
            `failed to restore stopped state after workspace export from ${this.id}`,
            new AggregateError(exportFailure === undefined ? [error] : [exportFailure, error]),
            this.id,
          );
        }
      }
    }
  }
  async restoreState(artifact: TransferArtifact, signal: AbortSignal): Promise<void> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    if (artifact.spec.kind === "git-patch")
      return await restoreGitPatch({ id: this.id, workdir: this.workdir, command: this.command }, artifact, signal);
    return await restoreWorkspace({ id: this.id, workdir: this.workdir, command: this.command }, artifact, signal);
  }
  async transitionToVerification(network: EnvironmentSpec["network"], signal: AbortSignal): Promise<void> {
    this.active();
    validateNetworkPolicy(network);
    await Promise.allSettled(this.starting);
    signal.throwIfAborted();
    // Restart only the managed idle entrypoint, reclaiming detached solver
    // descendants before any private verifier material is uploaded.
    if (this.project && network === undefined) {
      // Sidecars may measure the running main service. Stop Solver processes,
      // capture trusted hooks, and only then quiesce the namespace for export.
      await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
      const running = (await this.command(["inspect", this.id, "--format", "{{.State.Running}}"], { signal })).stdout.trim();
      if (running !== "true" && running !== "false")
        throw new DockerEnvironmentError("ARTIFACT_COLLECTION_INCOMPLETE", `Cannot determine main container state before collection: ${this.id}`);
      if (running === "false") {
        // Timeout cancellation stops main's entire namespace. Restart only the
        // managed idle entrypoint; leave live sidecars and their evidence intact.
        await this.project.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
    } else await this.quiesce(signal);
    this.quiesced = false;
    if (typeof network === "object") {
      if (!this.gateway) throw new Error("Shared verifier needs a prepared gateway for allowlist; declare a separate verifier environment");
      await this.gateway.resume(signal);
      await this.gateway.setAllowedHosts(network.allowedHosts, signal);
      await startModelForwarder(this.command, this.id, signal);
      this.processEnv = { ...EGRESS_PROXY_ENV };
    } else if (network === "bridge" && this.gateway) {
      await this.gateway.suspend(signal);
      await this.command(["network", "disconnect", "none", this.id], { signal });
      await this.command(["network", "connect", "bridge", this.id], { signal });
      this.processEnv = Object.fromEntries(Object.keys(EGRESS_PROXY_ENV).map(key => [key, ""]));
    } else if (this.gateway && network !== "none") {
      await this.gateway.resume(signal);
      if (network === "model-api") await this.gateway.setAllowedHosts([], signal);
      await startModelForwarder(this.command, this.id, signal);
    }
    if (network === "none") {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks: unknown = JSON.parse(inspected.stdout);
      if (!networks || typeof networks !== "object" || Array.isArray(networks)) throw new Error("Invalid Docker network inventory");
      for (const name of Object.keys(networks)) {
        if (name !== "none") await this.command(["network", "disconnect", name, this.id], { signal });
      }
      await this.gateway?.suspend(signal);
    }
    this.metadata.phase = "verify";
    await makeDockerLogsWritable(this.command, this.id, this.logOwners, signal);
    // The task filesystem survives the phase transition.
    await this.command(["exec", this.id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "mkdir", "/logs/verifier", "/logs/verifier/.evaluator-placeholder"], { signal });
  }
  async transitionToSolve(network: EnvironmentSpec["network"], signal: AbortSignal, users?: EnvironmentSpec["executionUsers"]): Promise<void> {
    this.active();
    await this.quiesce(signal);
    // Private scripts and rewards must disappear before any network or Solver
    // process is restored. rm removes links themselves, never their targets.
    const clean = "const f=require('node:fs/promises');(async()=>{for(const p of ['/tests','/environment'])await f.rm(p,{recursive:true,force:true});for(const p of ['/logs/verifier','/logs/agent'])for(const n of await f.readdir(p))await f.rm(p+'/'+n,{recursive:true,force:true});})().catch(e=>{console.error(e);process.exit(1)});";
    await this.command(["exec", "--user", "0", this.id, EVALUATOR_NODE_EXECUTABLE, "-e", clean], { signal });
    if (typeof network === "object" || network === "model-api") {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks = JSON.parse(inspected.stdout) as Record<string, unknown>;
      for (const name of Object.keys(networks)) if (name !== "none")
        await this.command(["network", "disconnect", name, this.id], { signal });
    }
    if (network === "bridge" && !this.gateway) {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks = JSON.parse(inspected.stdout) as Record<string, unknown>;
      if (!networks.bridge) {
        if (networks.none) await this.command(["network", "disconnect", "none", this.id], { signal });
        await this.command(["network", "connect", "bridge", this.id], { signal });
      }
    }
    await this.transitionToVerification(network, signal);
    if (users) this.metadata.executionUsers = users;
    this.metadata.phase = "solve";
  }
  async quiesce(signal: AbortSignal): Promise<void> {
    this.active();
    this.quiesced = true;
    await Promise.allSettled(this.starting);
    signal.throwIfAborted();
    await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
    // Stop the entire PID namespace, including detached writers. Restart only
    // our fixed idle entrypoint so controlled export can use docker exec.
    await this.project?.enterMaintenance(signal);
    await stopDockerContainer(this.command, this.id, signal);
    signal.throwIfAborted();
    await this.command(["start", this.id], { signal });
    await restoreDockerLogOwnership(this.command, this.id, this.logOwners, signal);
  }

  async startService(service: string, command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    this.active();
    if (!this.project) throw new Error("Environment has no sidecar services");
    return this.project.start(service, command, signal);
  }

  dispose(signal: AbortSignal): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      this.quiesced = true;
      await Promise.allSettled(this.starting);
      await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS).catch(() => {})));
      const failures: unknown[] = [];
      try {
        // Stop detached writers before handing private 0600 evidence back to
        // its original host owner; collection runs after this session ends.
        await this.project?.enterMaintenance(signal);
        await stopDockerContainer(this.command, this.id, signal);
        await this.command(["start", this.id], { signal });
        await restoreDockerLogOwnership(this.command, this.id, this.logOwners, signal);
      } catch (error) { failures.push(error); }
      // The task's mount keeps the socket volume in use even after the gateway
      // stops. Remove the task first, sharing the caller's cleanup budget.
      try { await (this.project ? this.project.dispose(signal) : removeDockerContainer(this.command, this.id, signal)); }
      catch (error) { failures.push(error); }
      try { await this.gateway?.dispose(signal); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) throw new DockerEnvironmentError("CLEANUP_FAILED",
        `failed to remove Docker session ${this.id}`, new AggregateError(failures));
    })();
    return this.disposal;
  }
}
