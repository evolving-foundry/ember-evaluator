import { runDockerCommand } from "../../../infrastructure/containers/command.js";
import { DockerEnvironmentError } from "../../../infrastructure/containers/error.js";
import { NetworkRuntime } from "../../../infrastructure/network/runtime.js";
import type { NetworkAccess } from "../../../core/contracts/network.js";
import { declaredErrorCode } from "../../../core/errors/classify.js";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dockerBuildNetwork } from "../../../infrastructure/containers/build-network.js";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { captureDockerLogOwnership, makeDockerLogsWritable } from "../../../infrastructure/containers/log-ownership.js";
import { assertDockerCapacity, readDockerCapacity, type DockerCapacity } from "../../../infrastructure/containers/resources.js";
import { applyBuildPipConstraints, parseBuildPipConstraints } from "../../../infrastructure/containers/pip-constraints.js";
import { readDirectoryModes, restoreDirectoryModes } from "../../../infrastructure/filesystem/directory-modes.js";
import { createDockerImagePuller, type DockerImagePull } from "../../../infrastructure/containers/image-pull.js";
import { DockerTaskArchive } from "../../../infrastructure/containers/task-archive.js";
import { dockerImageName, type DockerImageScope } from "../../../infrastructure/containers/image-name.js";
import { resolvePinnedTaskImage } from "../../../infrastructure/containers/base-image.js";
import { dockerActivity, observeDockerCommand, withDockerActivity } from "../../../infrastructure/containers/progress.js";
import type { ActivityListener } from "../../../core/contracts/activity.js";
import { constrainDockerCpus, cpuBudgetNodeOptions, cpuCountForBudget } from "../../../infrastructure/containers/cpu.js";
import type { ContainerPlatform, Environment, EnvironmentSession, EnvironmentSpec, EnvironmentPreparationTimings, EnvironmentImageReady, EnvironmentPreparationContext, PreparationCacheSource, RuntimeInstallation, RuntimeRequirement } from "../../../core/contracts/environment.js";
import type { AttemptKey, AttemptPaths } from "../../../core/contracts/result.js";
import type { JsonValue } from "../../../core/contracts/task.js";
import { validateNetworkPolicy } from "../../../core/policies/network-policy.js";
import { EGRESS_PROXY_ENV } from "../../../infrastructure/network/egress-proxy.js";
import { buildFileManifest } from "../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import { recoverDockerAttempts } from "../../../infrastructure/containers/recovery.js";
import { DockerBuildCache } from "../../../infrastructure/containers/build-cache.js";
import { DOCKER_PLATFORM, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand, type PreparedRuntimeImage } from "../../../infrastructure/containers/runtime-contract.js";
import { DockerRuntime } from "../../../infrastructure/containers/runtime.js";
import { PlatformCapabilityDetector, parseDockerPlatform, parseDockerEmulation, resolveDockerPlatform, nodePlatform, type DockerPlatformSelection } from "../../../infrastructure/containers/platform.js";
import { DockerSolverRuntime } from "../../../infrastructure/containers/solver-runtime.js";
import { DockerComposeProject, recoverComposeNetworks } from "../../../infrastructure/containers/compose.js";
import { platformImageCommand } from "../../../infrastructure/containers/image-inspect.js";
import { DockerImageInventory } from "../../../infrastructure/containers/image-inventory.js";
import { waitTaskHealth } from "../../../infrastructure/containers/healthcheck.js";
import { GATEWAY_SOCKET_TARGET, MODEL_FORWARDER_PORT, cleanupGatewayVolumes, createModelGateway, gatewayProxyEnv, dockerHostModelEndpoint, parseModelEndpointPolicy, startModelForwarder, type GatewayHandle } from "../../../infrastructure/network/model-gateway.js";
import { classifyError } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { DockerSession, type DockerMetadata } from "./session.js";
import { assertLinkFree, within, containerWorkdir, containerFileTarget } from "./paths.js";

// Direct egress to pypi.org/deb.debian.org is unreliable on CN networks, so the
// Task builds receive explicit per-run network settings.


export function parseDockerContainerEnv(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("docker containerEnv must be an object of strings");
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof item !== "string" || item.includes("\0"))
      throw new TypeError("docker containerEnv must contain valid environment names and string values without NUL");
  }
  return Object.fromEntries(entries);
}

export function parseDockerImageOverrides(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("docker imageOverrides must be an object of image references");
  const entries = Object.entries(value);
  for (const [source, target] of entries) {
    if (!source || /[\s\0]/u.test(source) || typeof target !== "string" || !target || /[\s\0]/u.test(target))
      throw new TypeError("docker imageOverrides must map non-empty image references without whitespace or NUL");
  }
  return Object.fromEntries(entries);
}

function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function writable(path: string, label: string): Promise<string> {
  try {
    const requested = resolve(path);
    const existing = await lstat(requested).catch(error => (errno(error, "ENOENT") ? null : Promise.reject(error)));
    if (existing?.isSymbolicLink()) throw new DockerEnvironmentError("TRANSFER_UNSAFE", `${label} is a symlink`);
    await mkdir(requested, { recursive: true });
    const actual = await realpath(requested);
    await access(actual, constants.R_OK | constants.W_OK);
    const probe = join(actual, `.docker-mount-probe-${randomUUID()}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
    return actual;
  } catch (error) {
    throw new DockerEnvironmentError("CONFIG_INVALID", `${label} is not writable: ${path}`, error);
  }
}

function versionMatches(actual: string, expected: string): boolean {
  const wanted = expected.trim().replace(/^v/u, "");
  if (wanted === "" || wanted === "*" || wanted === "any") return true;
  const normalized = wanted.replace(/\.x$/u, "");
  return actual === normalized || actual.startsWith(`${normalized}.`);
}

async function allocationKey(paths: AttemptPaths): Promise<AttemptKey> {
  try {
    const value = JSON.parse(await readFile(join(paths.root, "allocation.json"), "utf8")) as {
      key?: Partial<AttemptKey>;
    };
    if (
      typeof value.key?.runId === "string" &&
      typeof value.key.taskId === "string" &&
      typeof value.key.attemptId === "string"
    )
      return value.key as AttemptKey;
  } catch {}
  return {
    runId: basename(dirname(dirname(dirname(paths.root)))) || "unknown",
    taskId: basename(dirname(dirname(paths.root))) || "unknown",
    attemptId: basename(paths.root) || "unknown",
  };
}

async function validateBuildContext(
  context: string,
  dockerfile: string,
): Promise<{ context: string; dockerfile: string }> {
  const requested = resolve(context);
  await assertLinkFree(requested, "Docker build context");
  const root = await realpath(requested);
  const file = resolve(root, dockerfile);
  if (!within(root, file)) throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile escapes build context");
  const actualFile = await realpath(file);
  if (!within(root, actualFile))
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile resolves outside build context");
  if (!(await lstat(actualFile)).isFile())
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile is not a regular file");
  return { context: root, dockerfile: actualFile };
}


type ResolvedBaseImage = { reference: string; pinnedReference: string; id: string };

export type DockerEnvironmentOptions = {
  imageConfigFingerprint?: string;
  /** Fetch external base images before an uncached build; never allocate task containers here. */
  prepareBuild?: (spec: EnvironmentSpec, signal: AbortSignal, activity?: ActivityListener) => Promise<void>;
  /** Supplement the benchmark requirement when EnvironmentSpec has no platform. */
  platform?: DockerPlatformSelection;
  /** Reject foreign architectures before probing or starting emulation. */
  allowEmulation?: boolean;
  /** Runtime diagnostic sink; not a YAML configuration field. */
  onWarning?: (message: string) => void;
  /** Explicit per-container runtime settings, shared by solve and verify. */
  containerEnv?: Record<string, string>;
  /** Per-task pip version bounds; * supplies defaults for other main images. */
  buildPipConstraints?: Record<string, string[]>;
  /** Exact, one-step mapping to explicitly prepared public task images. */
  imageOverrides?: Record<string, string>;
  network?: import("../../../core/contracts/network.js").NetworkAccess | undefined;
  benchmarkName?: string | undefined;
  dockerExecutable?: string;
  nodeImage?: string;
  modelEndpoint?: string | null;
  /** Base task image for benchmarks that do not ship container images. */
  image?: string;
};

async function preflightRuntimes(
  command: DockerCommand,
  containerId: string,
  requirements: RuntimeRequirement[],
  signal: AbortSignal,
  target: ContainerPlatform,
): Promise<PreparedRuntimeImage["runtimes"]> {
  const platform = (
    await command(["exec", containerId, EVALUATOR_NODE_EXECUTABLE, "-e", "process.stdout.write(process.platform + '/' + process.arch)"], {
      signal,
    })
  ).stdout.trim();
  if (platform !== nodePlatform(target))
    throw new DockerEnvironmentError(
      "ENV_ARCH_UNSUPPORTED",
      `Docker container runtime is ${platform || "unknown"}; ${nodePlatform(target)} is required`,
    );
  const result: PreparedRuntimeImage["runtimes"] = [];
  for (const requirement of requirements) {
    if (requirement.name === "node") {
      const version = (await command(["exec", containerId, EVALUATOR_NODE_EXECUTABLE, "--version"], { signal })).stdout
        .trim()
        .replace(/^v/u, "");
      if (!versionMatches(version, requirement.version))
        throw new DockerEnvironmentError(
          "ENV_RUNTIME_INSTALL_FAILED",
          `node ${requirement.version} is required; container has ${version}`,
        );
      result.push({ name: "node", version, executable: "/usr/local/bin/node" });
    } else if (requirement.name === "bash" || requirement.name === "shell") {
      const output = (await command(["exec", containerId, "bash", "--version"], { signal })).stdout;
      const version = output.match(/version\s+(\d+(?:\.\d+)+)/iu)?.[1] ?? "unknown";
      if (!versionMatches(version, requirement.version))
        throw new DockerEnvironmentError(
          "ENV_RUNTIME_INSTALL_FAILED",
          `bash ${requirement.version} is required; container has ${version}`,
        );
      result.push({ name: "bash", version, executable: "bash" });
    }
  }
  return result;
}

export class DockerEnvironment implements Environment {
  private readonly prepareBuild: DockerEnvironmentOptions["prepareBuild"];
  readonly supportsRuntimeInstallation = true;
  private readonly containerEnv: Record<string, string>;
  private readonly buildPipConstraints: Record<string, string[]>;
  private readonly imageOverrides: Record<string, string>;
  private readonly taskImageCache = new DockerBuildCache<string>();
  private capacity: Promise<DockerCapacity> | undefined;
  private readonly attemptBaseImages = new Map<string, Promise<ResolvedBaseImage>>();
  private readonly dockerExecutable: string;
  private readonly command: DockerCommand;
  private readonly imageInventory: DockerImageInventory;
  private readonly imageConfigFingerprint: string | undefined;
  private readonly network: NetworkAccess;
  private readonly pullImage: DockerImagePull;
  private readonly pullTaskImage: DockerImagePull;
  private readonly taskArchive: DockerTaskArchive | undefined;
  private readonly platformSelection: DockerPlatformSelection;
  private readonly allowEmulation: boolean;
  private readonly capabilities: PlatformCapabilityDetector;
  private readonly nodeImage: string;
  private readonly runtimes = new Map<ContainerPlatform, { runtime: DockerRuntime; solverRuntime: DockerSolverRuntime }>();
  /** Configured model endpoint; required by the "model-api" network policy. */
  private readonly modelEndpoint: string | null;
  /** Base task image used when the benchmark's environment spec has no image. */
  private readonly defaultImage: string | null;
  constructor(options: DockerEnvironmentOptions = {}) {
    this.network = options.network ?? new NetworkRuntime();
    this.prepareBuild = options.prepareBuild;
    this.platformSelection = parseDockerPlatform(options.platform);
    this.allowEmulation = parseDockerEmulation(options.allowEmulation);
    this.containerEnv = parseDockerContainerEnv(options.containerEnv);
    this.buildPipConstraints = parseBuildPipConstraints(options.buildPipConstraints);
    this.imageOverrides = parseDockerImageOverrides(options.imageOverrides);
    this.dockerExecutable = options.dockerExecutable ?? "docker";
    this.command = observeDockerCommand(platformImageCommand(async (args, commandOptions) => {
      try { return await runDockerCommand(this.dockerExecutable, args, commandOptions); }
      catch (cause) {
        const operation = args[0];
        if (operation && ["pull", "build", "create", "start"].includes(operation)) {
          const failure = classifyError(cause, { phase: "environment", component: "docker", operation });
          throw new EvaluatorError(failure.code, failure.message, failure.details, { cause });
        }
        throw cause;
      }
    }));
    this.imageInventory = new DockerImageInventory(this.command);
    this.command = this.imageInventory.command;
    this.imageConfigFingerprint = options.imageConfigFingerprint;
    this.pullImage = createDockerImagePuller(this.command, { network: this.network });
    const acquisition = options.benchmarkName ? this.network.settings.docker.benchmarks[options.benchmarkName] : undefined;
    this.taskArchive = acquisition?.method === "archive" ? new DockerTaskArchive(this.command, acquisition, this.network) : undefined;
    this.pullTaskImage = createDockerImagePuller(this.command, { network: this.network,
      acquisition: acquisition?.method === "archive" ? undefined : acquisition });
    this.nodeImage = new DockerRuntime(this.command, options.nodeImage, DOCKER_PLATFORM, this.pullImage, this.dockerExecutable).nodeImage;
    this.capabilities = new PlatformCapabilityDetector(this.command, options.onWarning);
    this.modelEndpoint = options.modelEndpoint ?? null;
    this.defaultImage = options.image ?? null;
  }
  private async platformContext(spec: Pick<EnvironmentSpec, "platform">, signal: AbortSignal) {
    const native = await this.capabilities.nativePlatform(signal);
    const resolution = resolveDockerPlatform(this.platformSelection, this.taskArchive ? undefined : spec.platform, native, this.allowEmulation);
    let runtimes = this.runtimes.get(resolution.platform);
    if (!runtimes) {
      const runtime = new DockerRuntime(this.command, this.nodeImage, resolution.platform, this.pullImage, this.dockerExecutable);
      runtimes = { runtime, solverRuntime: new DockerSolverRuntime(this.command, runtime, this.network) };
      this.runtimes.set(resolution.platform, runtimes);
    }
    const { runtime, solverRuntime } = runtimes;
    await this.capabilities.ensure(resolution, signal, async active => {
      await runtime.nodeImageDigest(active);
      return runtime.nodeImage;
    });
    return { resolution, platform: resolution.platform, runtime, solverRuntime };
  }
  async installRuntime(installation: RuntimeInstallation, signal: AbortSignal, spec?: EnvironmentSpec, activity?: ActivityListener): Promise<void> {
    return this.imageInventory.use(undefined, signal, () => withDockerActivity(activity, () => this.installRuntimeObserved(installation, signal, spec)));
  }
  acquireImageLease(signal: AbortSignal) { return this.imageInventory.lease(signal); }
  private async installRuntimeObserved(installation: RuntimeInstallation, signal: AbortSignal, spec?: EnvironmentSpec): Promise<void> {
    signal.throwIfAborted();
    const { solverRuntime } = await this.platformContext(spec ?? {}, signal);
    await solverRuntime.install(installation, signal);
  }
  async recoverAttempts(keys: AttemptKey[], signal: AbortSignal): Promise<void> {
    await recoverDockerAttempts(this.command, keys, signal);
    await recoverComposeNetworks(this.command, keys, signal);
    // Gateway containers carry the same attempt labels and are reaped above;
    // their socket volumes need an explicit sweep.
    await cleanupGatewayVolumes(this.command, keys, signal);
  }
  private async taskImage(spec: EnvironmentSpec, platform: ContainerPlatform, signal: AbortSignal, observe?: (source: PreparationCacheSource) => void, useImageOverrides = true, scope?: DockerImageScope): Promise<string> {
    if (spec.image !== null) {
      observe?.("reference");
      const override = useImageOverrides && Object.hasOwn(this.imageOverrides, spec.image) ? this.imageOverrides[spec.image] : undefined;
      return override ?? spec.image;
    }
    if (!spec.build) throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", "Docker environment requires image or build");
    const constraintTaskId = scope && Object.hasOwn(this.buildPipConstraints, scope.taskId) ? scope.taskId : "*";
    const pipConstraints = scope?.service ? [] : this.buildPipConstraints[constraintTaskId] ?? [];
    const context = await validateBuildContext(spec.build.context, spec.build.dockerfile);
    const manifest = await buildFileManifest(context.context, []);
    if (manifest.missing.length)
      throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Docker build context contains an unreadable or unsafe entry");
    const actualSourceHash = fingerprintConfig(manifest.files as unknown as JsonValue);
    if (actualSourceHash !== spec.build.sourceHash)
      throw new DockerEnvironmentError(
        "SOURCE_CHANGED",
        "Docker build context no longer matches its public source hash",
      );
    const sourceModes = await readDirectoryModes(context.context, signal);
    let network;
    try { network = dockerBuildNetwork(this.network); }
    catch (cause) { throw new DockerEnvironmentError("CONFIG_INVALID", "Invalid Docker build network settings", cause); }
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          sourceHash: spec.build.sourceHash,
          permissions: sourceModes,
          mirrorPolicy: "ca-bootstrap-v5-apt-network-defaults",
          platform,
          network: network.identity,
          dockerfile: relative(context.context, context.dockerfile).replaceAll("\\", "/"),
          ...(pipConstraints.length ? { pipConstraints } : {}),
          ...(spec.build.noCache ? { freshBuild: randomUUID() } : {}),
        }),
      )
      .digest("hex");
    const tag = dockerImageName(scope ? "task" : "solve-task", key, scope);
    // Public contexts with identical bytes can contain a large shared corpus.
    // Build and snapshot them once; retain task-specific aliases for inspection.
    const buildTag = spec.build.visibility === "public" ? dockerImageName("solve-task", key) : tag;
    const reference = await this.taskImageCache.getImage(this.dockerExecutable, buildTag, signal, async buildSignal => {
      try {
        await this.command(["image", "inspect", "--platform", platform, buildTag, "--format", "{{.Id}}"], { signal: buildSignal });
        observe?.("image");
        return buildTag;
      } catch {}
      buildSignal.throwIfAborted();
      const staging = await mkdtemp(join(tmpdir(), "ember-docker-context-"));
      try {
        const snapshot = join(staging, "context");
        await cp(context.context, snapshot, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
        });
        await assertLinkFree(snapshot, "Docker build context snapshot");
        await restoreDirectoryModes(snapshot, sourceModes, buildSignal);
        const snapshotManifest = await buildFileManifest(snapshot, []);
        if (
          snapshotManifest.missing.length ||
          fingerprintConfig(snapshotManifest.files as unknown as JsonValue) !== spec.build!.sourceHash ||
          fingerprintConfig(await readDirectoryModes(context.context, buildSignal) as unknown as JsonValue) !==
            fingerprintConfig(sourceModes as unknown as JsonValue) ||
          fingerprintConfig(await readDirectoryModes(snapshot, buildSignal) as unknown as JsonValue) !==
            fingerprintConfig(sourceModes as unknown as JsonValue)
        ) {
          throw new DockerEnvironmentError(
            "SOURCE_CHANGED",
            "Docker build context content or permissions changed while its public snapshot was created",
          );
        }
        const dockerfile = resolve(snapshot, relative(context.context, context.dockerfile));
        await this.prepareBuild?.({ ...spec, build: { ...spec.build!, context: snapshot,
          dockerfile: relative(snapshot, dockerfile).replaceAll("\\", "/") } }, buildSignal, dockerActivity());
        buildSignal.throwIfAborted();
        await applyBuildPipConstraints(snapshot, dockerfile, pipConstraints, buildSignal);
        const buildArgs = network.buildArgs;
        await writeFile(dockerfile, network.recipe(await readFile(dockerfile, "utf8")));
        await this.command(["build", "--platform", platform, ...(spec.build?.noCache ? ["--no-cache"] : []), ...buildArgs, "--tag", buildTag, "--file", dockerfile, snapshot], {
          env: network.environment,
          signal: buildSignal,
          maxBuffer: 8 * 1024 * 1024,
        });
        observe?.("built");
        return buildTag;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }, observe);
    if (reference !== tag) await this.command(["image", "tag", reference, tag], { signal });
    return tag;
  }
  private async baseImage(spec: EnvironmentSpec, platform: ContainerPlatform, key: AttemptKey, signal: AbortSignal, observe?: (source: PreparationCacheSource) => void, useImageOverrides = true, scope?: DockerImageScope): Promise<ResolvedBaseImage> {
    if (this.taskArchive && scope) return this.taskArchive.load(scope, platform, signal, observe);
    // Validate the public build context on every phase before consulting the
    // task-image cache, while keeping a mutable image tag pinned per attempt.
    const reference = await this.taskImage(spec, platform, signal, observe, useImageOverrides, scope);
    const pull: DockerImagePull = (image, target, active) => this.pullTaskImage(image, target, active, scope);
    const pinned = await resolvePinnedTaskImage(this.command, reference, platform, scope, signal, observe, pull);
    if (pinned) return pinned;
    const attempt = JSON.stringify([key.runId, key.taskId, key.attemptId, platform, reference, scope]);
    const cached = this.attemptBaseImages.get(attempt);
    if (cached) return await cached;
    const resolution = (async () => {
      let localReference = reference;
      let inspected;
      try {
        inspected = await this.command(["image", "inspect", "--platform", platform, reference, "--format", "{{.Id}}"], { signal });
      } catch (inspectError) {
        try {
          localReference = (await pull(reference, platform, signal)).reference;
        } catch (pullError) {
          throw new DockerEnvironmentError(
            "ENV_IMAGE_PULL_FAILED",
            `cannot inspect or pull Docker image ${reference}`,
            new AggregateError([inspectError, pullError]),
          );
        }
        inspected = await this.command(["image", "inspect", "--platform", platform, localReference, "--format", "{{.Id}}"], { signal });
      }
      const id = inspected.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/u.test(id))
        throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Docker returned an invalid image ID for ${reference}`);
      const actualPlatform = (await this.command(["image", "inspect", "--platform", platform, localReference,
        "--format", "{{.Os}}/{{.Architecture}}"], { signal })).stdout.trim();
      if (actualPlatform !== platform)
        throw new EvaluatorError("ENV_ARCH_UNSUPPORTED",
          `Task image ${reference} is ${actualPlatform || "unknown"}; resolved target is ${platform}`,
          { component: "docker", operation: "image-inspect" });
      const tagHash = createHash("sha256").update(`${attempt}\0${id}`).digest("hex").slice(0, 24);
      const pinnedReference = dockerImageName(scope ? "base" : key.taskId === "gateway" ? "gateway-base" : "solve-base", tagHash, scope);
      await this.command(["image", "tag", localReference, pinnedReference], { signal });
      return { reference, pinnedReference, id };
    })();
    this.attemptBaseImages.set(attempt, resolution);
    try {
      return await resolution;
    } catch (error) {
      this.attemptBaseImages.delete(attempt);
      throw error;
    }
  }
  private async addressableImage(reference: string, signal: AbortSignal): Promise<string> {
    // containerd may return a platform config ID from --platform that cannot
    // itself be used as an image reference. Use the addressable root ID to launch.
    const id = (await this.command(["image", "inspect", reference, "--format", "{{.Id}}"], { signal })).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(id))
      throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Preparation returned an invalid addressable image identity for ${reference}`);
    return id;
  }
  private async admitResources(spec: EnvironmentSpec, signal: AbortSignal): Promise<void> {
    if (spec.resources?.cpus === undefined && spec.resources?.memory === undefined) return;
    this.capacity ??= readDockerCapacity(this.command, signal).catch(error => { this.capacity = undefined; throw error; });
    assertDockerCapacity(spec.resources, await this.capacity);
  }
  private validateTaskNetwork(spec: EnvironmentSpec): void {
    validateNetworkPolicy(spec.network);
    if (Object.keys(spec.services ?? {}).some(name => name !== "main") && (spec.network ?? "bridge") !== "bridge")
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "Multi-container tasks require a task-scoped bridge network; isolated egress policies cannot be weakened");
  }
  async materialize(spec: EnvironmentSpec, signal: AbortSignal, onImageReady?: (timing: EnvironmentImageReady) => void, activity?: ActivityListener, context?: EnvironmentPreparationContext): Promise<EnvironmentSpec> {
    return this.imageInventory.use(context && this.imageConfigFingerprint ? { configFingerprint: this.imageConfigFingerprint, ...context } : undefined,
      signal, async () => {
        const prepared = await withDockerActivity(activity, () => this.materializeObserved(spec, signal, onImageReady, context));
        await this.imageInventory.associatePrepared(prepared.prepared, signal);
        return prepared;
      });
  }
  cleanupImages(request: import("../../../core/contracts/image-cleanup.js").ImageCleanupRequest, signal: AbortSignal) {
    return this.imageInventory.cleanup(request, signal);
  }
  private async materializeObserved(spec: EnvironmentSpec, signal: AbortSignal, onImageReady?: (timing: EnvironmentImageReady) => void, context?: EnvironmentPreparationContext): Promise<EnvironmentSpec> {
    this.validateTaskNetwork(spec);
    signal.throwIfAborted();
    await this.admitResources(spec, signal);
    const { resolution, platform, runtime: nodeRuntime, solverRuntime } = await this.platformContext(spec, signal);
    const cache: NonNullable<EnvironmentPreparationTimings["cache"]> = {};
    const imageStarted = performance.now();
    const baseImage = await this.baseImage(
      spec.image === null && !spec.build && this.defaultImage !== null ? { ...spec, image: this.defaultImage } : spec, platform,
      { runId: "preparation", taskId: context?.taskId ?? "shared", attemptId: randomUUID() }, signal, source => { cache.image = source; }, true, context,
    );
    const imageMs = performance.now() - imageStarted;
    signal.throwIfAborted();
    onImageReady?.({ imageMs, ...(cache.image === undefined ? {} : { cache: cache.image }) });
    const runtimeStarted = performance.now();
    const runtime = await nodeRuntime.prepare(baseImage.pinnedReference, spec.runtime, signal, source => { cache.runtime = source; }, context);
    const runtimeMs = performance.now() - runtimeStarted;
    const solverStarted = performance.now();
    const solverImage = spec.installation
      ? await solverRuntime.prepare(runtime.image, runtime.digest, spec.installation, signal, source => { cache.solver = source; }, context)
      : undefined;
    const solverMs = spec.installation ? performance.now() - solverStarted : 0;
    const launchImage = await this.addressableImage(solverImage?.image ?? runtime.image, signal);
    let gatewayImage: string | null = null;
    let gatewayDigest: string | null = null;
    if (spec.network === "model-api" || typeof spec.network === "object") {
      // A task image mapping must never replace the pinned internal gateway.
      gatewayDigest = (await this.baseImage({ ...spec, image: nodeRuntime.nodeImage }, platform, { runId: "preparation", taskId: "gateway", attemptId: randomUUID() }, signal, undefined, false)).id;
      gatewayImage = await this.addressableImage(nodeRuntime.nodeImage, signal);
    }
    const serviceImages: Record<string, string> = {};
    for (const [name, service] of Object.entries(spec.services ?? {})) {
      if (name === "main") continue;
      const sidecar: EnvironmentSpec = { workdir: "/", image: service.image, initialFiles: [], runtime: [],
        ...(service.build ? { build: service.build } : {}) };
      const scope: DockerImageScope = { taskId: context?.taskId ?? "shared", phase: context?.phase ?? "solve", service: name };
      const resolved = await this.baseImage(sidecar, platform, { runId: "preparation", taskId: scope.taskId, attemptId: randomUUID() }, signal, undefined, true, scope);
      serviceImages[name] = await this.addressableImage(resolved.pinnedReference, signal);
    }
    return { ...spec, preparationTiming: { imageMs, runtimeMs, solverMs, cache }, prepared: { kind: "docker", platform, platformResolution: resolution, baseImage, runtime, solverImage: solverImage ?? null, launchImage, gatewayImage, gatewayDigest, serviceImages } };
  }
  async prepare(
    spec: EnvironmentSpec,
    paths: AttemptPaths,
    phase: "solve" | "verify",
    signal: AbortSignal,
    activity?: ActivityListener,
  ): Promise<EnvironmentSession> {
    const { value: session, release } = await this.imageInventory.hold(undefined, signal,
      () => withDockerActivity(activity, () => this.prepareObserved(spec, paths, phase, signal)));
    const dispose = session.dispose.bind(session);
    session.dispose = async active => { try { await dispose(active); } finally { await release(); } };
    return session;
  }
  private async prepareObserved(
    spec: EnvironmentSpec, paths: AttemptPaths, phase: "solve" | "verify", signal: AbortSignal,
  ): Promise<EnvironmentSession> {
    signal.throwIfAborted();
    this.validateTaskNetwork(spec);
    if (spec.services && spec.prepared === undefined) return this.prepare(await this.materialize(spec, signal, undefined, undefined,
      { taskId: (await allocationKey(paths)).taskId, phase }), paths, phase, signal);
    await this.admitResources(spec, signal);
    this.validateTaskNetwork(spec);
    if (phase === "solve" && spec.build?.visibility === "verifier")
      throw new DockerEnvironmentError("CONFIG_INVALID", "Private verifier images cannot be used for solving");
    if (phase === "verify" && spec.installation)
      throw new DockerEnvironmentError("ENV_RUNTIME_INSTALL_FAILED", "verifier environments cannot install solver runtimes");
    if (spec.resources?.cpus !== undefined) cpuCountForBudget(spec.resources.cpus);
    const prepared = spec.prepared;
    if (prepared !== undefined && (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || prepared.kind !== "docker"))
      throw new DockerEnvironmentError("ENV_PREPARATION_FAILED", "Invalid Docker preparation receipt");
    const workdir = containerWorkdir(spec.workdir);
    const { resolution, platform, runtime: nodeRuntime, solverRuntime } = await this.platformContext(spec, signal);
    if (prepared && typeof prepared === "object" && !Array.isArray(prepared)
      && (prepared.platform ?? DOCKER_PLATFORM) !== platform)
      throw new EvaluatorError("ENV_ARCH_UNSUPPORTED", "Prepared Docker platform differs from the resolved task platform");
    // Different container UIDs may write the log mounts; their host parent
    // remains private to the coordinator regardless of its startup umask.
    await chmod(await writable(paths.root, "attempt directory"), 0o700);
    const [agent, verifier, key] = await Promise.all([
      writable(paths.agent, "agent output directory"),
      writable(paths.verifier, "verifier output directory"),
      allocationKey(paths),
    ]);
    const receipt = prepared as { launchImage: string; gatewayImage: string | null; gatewayDigest: string | null; baseImage: ResolvedBaseImage; runtime: PreparedRuntimeImage; solverImage: Awaited<ReturnType<DockerSolverRuntime["prepare"]>> | null; serviceImages?: Record<string, string> } | undefined;
    const scope: DockerImageScope = { taskId: key.taskId, phase };
    const baseImage = receipt?.baseImage ?? await this.baseImage(
      spec.image === null && !spec.build && this.defaultImage !== null ? { ...spec, image: this.defaultImage } : spec, platform,
      key, signal, undefined, true, scope,
    );
    const runtime = receipt?.runtime ?? await nodeRuntime.prepare(baseImage.pinnedReference, spec.runtime, signal, undefined, scope);
    const solverImage = receipt ? receipt.solverImage ?? undefined : spec.installation
      ? await solverRuntime.prepare(runtime.image, runtime.digest, spec.installation, signal, undefined, scope)
      : undefined;
    if (receipt) {
      const id = solverImage?.digest ?? runtime.digest;
      try {
        const images = [{ reference: receipt.launchImage, digest: id }];
        if (receipt.gatewayImage && receipt.gatewayDigest) images.push({ reference: receipt.gatewayImage, digest: receipt.gatewayDigest });
        for (const image of images) {
          const inspected = await this.command(["image", "inspect", "--platform", platform, image.reference, "--format", "{{.Id}}"], { signal });
          if (inspected.stdout.trim() !== image.digest) throw new Error("Image identity changed");
        }
      } catch (cause) {
        signal.throwIfAborted();
        throw new DockerEnvironmentError("ENV_PREPARED_IMAGE_LOST", "Prepared image identity is unavailable; start a new preparation round", cause);
      }
    }
    const labels = [
      ["run", key.runId],
      ["task", key.taskId],
      ["attempt", key.attemptId],
      ["phase", phase],
    ] as const;
    const mounts: { source: string; target: string }[] = [];
    if (spec.sharedLogs === true) {
      // A shared log root lets the agent stage evidence outside /logs/agent
      // (e.g. /logs/artifacts) for the verifier; per-phase mounts shadow their
      // own subdirectories.
      const shared = await writable(join(paths.root, "logs"), "shared log directory");
      mounts.push({ source: shared, target: "/logs" });
    }
    mounts.push(
      phase === "solve" ? { source: agent, target: "/logs/agent" } : { source: verifier, target: "/logs/verifier" },
    );
    // The directory is empty during solve. No hidden grading material is placed
    // here until the Benchmark starts verification in a shared environment.
    if (phase === "solve") mounts.push({ source: verifier, target: "/logs/verifier" });
    // Keep runtime routes explicit. An unavailable proxy is an error, never an implicit direct fallback.
    const runtimeEnvironment = this.network.environment("runtime", {}, "container");
    const forwardedEnv = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
      .flatMap(key => ["--env", `${key}=${runtimeEnvironment[key] ?? ""}`]);
    if (runtimeEnvironment.HTTP_PROXY || runtimeEnvironment.HTTPS_PROXY) forwardedEnv.push("--env", "NODE_USE_ENV_PROXY=1");
    // "model-api" keeps the task container itself on --network none; only the
    // gateway container holds external network, and isolated containers must
    // not inherit host proxy settings that could bypass the policy.
    const isolatedGateway = spec.network === "model-api" || typeof spec.network === "object";
    const allowlist = typeof spec.network === "object" ? spec.network : undefined;
    let gateway: GatewayHandle | undefined;
    const volumeMounts: { source: string; target: string }[] = [];
    const modelPolicy = isolatedGateway
      ? typeof this.modelEndpoint === "string" && this.modelEndpoint !== ""
        ? parseModelEndpointPolicy(this.modelEndpoint)
        : null
      : undefined;
    if (spec.network === "model-api" && modelPolicy === null)
      throw new DockerEnvironmentError(
        "CONFIG_INVALID",
        'network "model-api" requires an explicit model endpoint',
      );
    const launchImage = receipt ? receipt.launchImage : solverImage?.image ?? runtime.image;
    const containerEnv = { ...this.containerEnv, ...parseDockerContainerEnv(spec.env) };
    // Apply deployment package mirrors to both standalone and Compose main
    // containers. Explicit task/config values win; model-only isolation stays.
    if (!isolatedGateway) for (const key of ["NPM_CONFIG_REGISTRY", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX"]) {
      const value = this.network.environment("runtime")[key];
      if (containerEnv[key] === undefined && value !== undefined && value !== "") containerEnv[key] = value;
    }
    if (spec.resources?.cpus !== undefined)
      containerEnv.NODE_OPTIONS = await cpuBudgetNodeOptions(this.command, launchImage, containerEnv.NODE_OPTIONS, signal);
    if (isolatedGateway) {
      if (allowlist) Object.assign(containerEnv, EGRESS_PROXY_ENV);
      gateway = await createModelGateway(this.command, {
        platform,
        preparedImage: receipt?.gatewayImage ?? nodeRuntime.nodeImage,
        ...(this.modelEndpoint ? { endpoint: this.modelEndpoint } : {}),
        ...(allowlist ? { allowedHosts: allowlist.allowedHosts } : {}),
        key,
        phase,
        // Only the gateway talks to the outside; it may use the coordinator's
        // proxy for that egress, but never the npm registry variable.
        proxyEnv: gatewayProxyEnv(forwardedEnv.filter(entry => entry !== "--env")),
        signal,
      });
      volumeMounts.push({ source: gateway.volume, target: GATEWAY_SOCKET_TARGET });
    }
    const createArgs = [
      "create",
      // Reap orphaned solver children and forward shutdown through a native
      // PID 1, including when the task's Node runtime is emulated on ARM.
      "--init",
      "--platform",
      platform,
      ...labels.flatMap(([name, value]) => ["--label", `ember.${name}=${value.replace(/[\u0000-\u001f\u007f]/gu, "_")}`]),
      ...Object.entries(containerEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--add-host", "host.docker.internal:host-gateway",
      ...(isolatedGateway ? [] : forwardedEnv),
      ...(spec.extraHosts ?? []).flatMap(host => ["--add-host", host]),
      ...mounts.map(mount => ["--mount", `type=bind,source=${mount.source},target=${mount.target}`]).flat(),
      ...volumeMounts.map(mount => ["--mount", `type=volume,source=${mount.source},target=${mount.target},readonly`]).flat(),
    ];
    if (spec.network === "none" || isolatedGateway) createArgs.push("--network", "none");
    if (spec.network === "host") createArgs.push("--network", "host");
    if (spec.resources?.cpus !== undefined) createArgs.push("--cpus", String(spec.resources.cpus));
    if (spec.resources?.memory !== undefined) createArgs.push("--memory", spec.resources.memory);
    if (receipt) createArgs.push("--pull", "never");
    createArgs.push("--entrypoint", EVALUATOR_NODE_EXECUTABLE, launchImage, PROCESS_HELPER, "idle");
    let containerId: string | null = null;
    let project: DockerComposeProject | undefined;
    try {
      signal.throwIfAborted();
      // Docker create is intentionally allowed to return its ID after an
      // in-flight cancellation so the labeled partial resource can be removed.
      if (spec.services) {
        project = new DockerComposeProject(this.command, this.dockerExecutable, spec, paths, key, phase);
        const labelMap = Object.fromEntries(labels.map(([name, value]) => [`ember.${name}`, value.replace(/[\u0000-\u001f\u007f]/gu, "_")]));
        containerId = await project.create({ image: launchImage, platform, init: true,
          command: [EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "idle"], environment: containerEnv, labels: labelMap,
          ...(spec.network === "none" || isolatedGateway ? { network_mode: "none" } : {}),
          ...(spec.network === "host" ? { network_mode: "host" } : {}),
          volumes: [
            ...mounts.map(mount => ({ type: "bind", source: mount.source, target: mount.target })),
            ...volumeMounts.map(mount => ({ type: "volume", source: mount.source, target: mount.target, read_only: true })),
          ],
          ...(spec.resources?.cpus === undefined ? {} : { cpus: spec.resources.cpus }),
          ...(spec.resources?.memory === undefined ? {} : { mem_limit: spec.resources.memory }) }, receipt?.serviceImages ?? {}, labelMap, signal);
      } else containerId = (await this.command(createArgs)).stdout.trim();
      if (!/^[a-f0-9]{12,64}$/u.test(containerId))
        throw new DockerEnvironmentError("ENV_CONTAINER_START_FAILED", "Docker returned an invalid container ID");
      await this.command(["start", containerId], { signal });
      const logOwners = await captureDockerLogOwnership(this.command, containerId, mounts.map(mount => mount.target), signal);
      await makeDockerLogsWritable(this.command, containerId, logOwners, signal);
      const cpuVisibility = spec.resources?.cpus === undefined ? undefined
        : await constrainDockerCpus(this.command, containerId, spec.resources.cpus, signal);
      const runtimes = await preflightRuntimes(this.command, containerId, spec.runtime, signal, platform);
      if (solverImage?.runtime.stateRoot) {
        await this.command(
          [
            "exec",
            containerId,
            EVALUATOR_NODE_EXECUTABLE,
            PROCESS_HELPER,
            "mkdir",
            solverImage.runtime.stateRoot,
            solverImage.runtime.stateRoot,
            "directory",
          ],
          { signal },
        );
      }
      await this.command(
        ["exec", containerId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "mkdir", workdir, `${workdir}/.evaluator-placeholder`],
        { signal },
      );
      for (const file of spec.initialFiles) {
        const requested = resolve(file.source);
        await assertLinkFree(requested, "initial file source");
        const source = await realpath(requested);
        const sourceStat = await lstat(source);
        const destination = containerFileTarget(workdir, file.target);
        await this.command(
          [
            "exec",
            containerId,
            EVALUATOR_NODE_EXECUTABLE,
            PROCESS_HELPER,
            "mkdir",
            destination.root,
            destination.target,
            sourceStat.isDirectory() ? "directory" : "file",
          ],
          { signal },
        );
        await this.command(
          ["cp", sourceStat.isDirectory() ? `${source}${sep}.` : source, `${containerId}:${destination.target}`],
          { signal, maxBuffer: 8 * 1024 * 1024 },
        );
      }
      if (gateway) {
        // The loopback forwarder bridges container-local HTTP to the shared
        // gateway socket; it dies with the container on dispose or recovery.
        await startModelForwarder(this.command, containerId, signal);
      }
      for (const user of new Set(Object.values(spec.executionUsers ?? {}))) {
        if (!/^[a-z_][a-z0-9_-]*$/u.test(user)) throw new TypeError("Invalid environment execution user");
        if (user === "root") continue;
        // Match WorkBuddy ensure_agent_user: create the account and grant its
        // workspace, leaving challenge ownership from the task image intact.
        const setup = 'u="$1"; if ! id "$u" >/dev/null 2>&1; then if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"; elif command -v adduser >/dev/null 2>&1; then adduser -D -s /bin/sh "$u"; else exit 1; fi; fi; mkdir -p /workspace; chown -R "$u" /workspace; git config --system --add safe.directory /workspace 2>/dev/null || true; git config --system --add safe.directory "*" 2>/dev/null || true';
        await this.command(["exec", "--user", "0", containerId, "sh", "-c", setup, "setup-user", user], { signal });
      }
      if (spec.healthcheck) await waitTaskHealth(this.command, containerId, spec.healthcheck, signal);
      const raw = JSON.parse((await this.command(["inspect", containerId], { signal })).stdout) as Array<{
        HostConfig?: { NanoCpus?: number; Memory?: number };
      }>;
      const host = raw[0]?.HostConfig;
      const metadata: DockerMetadata = {
        ...(spec.executionUsers === undefined ? {} : { executionUsers: spec.executionUsers }),
        kind: "docker",
        phase,
        platform,
        platformResolution: resolution,
        containerId,
        baseImage: { reference: baseImage.reference, id: baseImage.id },
        ...(project ? { services: { project: project.name, containers: project.identities } } : {}),
        derivedImage: { reference: solverImage?.image ?? runtime.image, id: solverImage?.digest ?? runtime.digest },
        runtimes,
        ...(solverImage ? { installation: solverImage.runtime } : {}),
        ...(gateway && modelPolicy
          ? {
              modelEndpoint: {
                baseUrl: `http://127.0.0.1:${MODEL_FORWARDER_PORT}${modelPolicy.pathPrefix}`,
                originEndpoint: this.modelEndpoint!,
                gateway: { containerId: gateway.containerId, image: gateway.image, volume: gateway.volume },
              },
            }
          : !isolatedGateway && spec.network !== "none" && spec.network !== "host" && this.modelEndpoint && dockerHostModelEndpoint(this.modelEndpoint) !== this.modelEndpoint
            ? { modelEndpoint: { baseUrl: dockerHostModelEndpoint(this.modelEndpoint), originEndpoint: this.modelEndpoint } }
            : {}),
        resources: {
          requested: {
            cpus: spec.resources?.cpus ?? null,
            memory: spec.resources?.memory ?? null,
            storage: spec.resources?.storage ?? null,
          },
          effective: {
            cpus: host?.NanoCpus ? host.NanoCpus / 1_000_000_000 : null,
            memoryBytes: host?.Memory || null,
            storage: { enforced: false },
            ...cpuVisibility,
          },
        },
      };
      return new DockerSession(
        containerId,
        workdir,
        "/logs/agent",
        "/logs/verifier",
        this.dockerExecutable,
        this.command,
        metadata,
        logOwners,
        gateway,
        project,
      );
    } catch (error) {
      if (project) {
        try { await project.dispose(AbortSignal.timeout(30_000)); }
        catch (cleanup) { throw new DockerEnvironmentError("CLEANUP_FAILED", "Task service group cleanup could not be confirmed", new AggregateError([error, cleanup])); }
        throw error;
      }
      let failure = error;
      if (containerId) {
        try { await rethrowPreparationFailure(this.command, containerId, error); }
        catch (error) { failure = error; }
      }
      try { await gateway?.dispose(); }
      catch (cleanupError) {
        throw new DockerEnvironmentError("CLEANUP_FAILED", "Failed to release preparation gateway", new AggregateError([failure, cleanupError]));
      }
      throw failure;
    }
  }
}

export async function rethrowPreparationFailure(
  command: DockerCommand,
  containerId: string,
  primary: unknown,
): Promise<never> {
  try {
    await command(["rm", "--force", containerId], { signal: AbortSignal.timeout(10_000) });
  } catch (cleanup) {
    throw new DockerEnvironmentError(
      "CLEANUP_FAILED",
      `Docker container ${containerId} preparation failed and cleanup also failed`,
      new AggregateError([primary, cleanup]),
      containerId,
    );
  }
  const code = declaredErrorCode(primary) ?? "ENV_PREPARATION_FAILED";
  const message = primary instanceof Error ? primary.message : String(primary);
  throw new DockerEnvironmentError(
    code,
    `Docker container ${containerId} preparation failed: ${message}`,
    primary,
    containerId,
  );
}
