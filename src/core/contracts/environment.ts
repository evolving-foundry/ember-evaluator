import type { JsonValue } from "./task.js";
import type { AttemptKey, AttemptPaths, Warning } from "./result.js";
import type { ActivityListener } from "./activity.js";

export type RuntimeRequirement = {
  name: string;
  version: string;
  platform: string;
};

export type RuntimeInstallCommand = {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type RuntimeInstallation = {
  id: string;
  /** Local cache parent (1–48 safe lowercase characters); defaults to "runtime". Excluded from the content identity. */
  cacheName?: string;
  files: { source: string; target: string }[];
  commands: RuntimeInstallCommand[];
  probes: RuntimeInstallCommand[];
  localRoot?: string;
};

export type RuntimeLocation = {
  root: string;
  stateRoot?: string;
  persistent: boolean;
  identity: string;
};

export type PreparationCacheSource = "memory" | "shared" | "image" | "built" | "reference";
/** Transient notification before runtime and solver image preparation. */
export type EnvironmentImageReady = { imageMs: number; cache?: PreparationCacheSource };
/** Optional display identity, supplied by the caller rather than task metadata. */
export type EnvironmentPreparationContext = { taskId: string; phase: "solve" | "verify" };
export type EnvironmentPreparationTimings = {
  imageMs: number;
  runtimeMs: number;
  solverMs: number;
  cache?: Partial<Record<"image" | "runtime" | "solver", PreparationCacheSource>>;
};

export type ContainerPlatform = "linux/amd64" | "linux/arm64";

/** Task-scoped services; external Compose syntax is normalized by the data adapter. */
export type ContainerService = {
  image: string | null;
  build?: NonNullable<EnvironmentSpec["build"]>;
  properties: Record<string, JsonValue>;
};

export type EnvironmentSpec = {
  executionUsers?: { solve?: string; verify?: string };
  services?: Record<string, ContainerService>;
  healthcheck?: { command: string; intervalSeconds: number; timeoutSeconds: number; retries: number; startPeriodSeconds: number; startIntervalSeconds: number };
  /** Benchmark-declared target, independent of the execution node architecture. */
  platform?: ContainerPlatform;
  /** Observed preparation durations, not execution limits or cache identities. */
  preparationTiming?: EnvironmentPreparationTimings;
  /** Environment-owned materialization receipt. Execution must not rebuild it. */
  prepared?: JsonValue;
  workdir: string;
  image: string | null;
  env?: Record<string, string>;
  extraHosts?: string[];
  initialFiles: { source: string; target: string }[];
  runtime: RuntimeRequirement[];
  installation?: RuntimeInstallation;
  /** Task environment build context. Private contexts are restricted to verifier environments. */
  build?: { context: string; dockerfile: string; sourceHash: string; visibility?: "public" | "verifier"; noCache?: boolean };
  resources?: { cpus?: number; memory?: string; storage?: string };
  /**
   * Container network policy; "bridge" is the Docker default. Explicit "host"
   * shares the local Docker host's network, including loopback metrics. "model-api" keeps
   * the container itself offline and only exposes the configured model endpoint
   * through an environment-managed gateway. An allowlist adds HTTP(S) egress
   * to exact domains or leading *. subdomains; [] denies task egress.
   * Backends must reject policies they cannot enforce.
   */
  network?: "bridge" | "host" | "none" | "model-api" | { kind: "allowlist"; allowedHosts: string[] };
  /**
   * Bind the attempt log directory at /logs in both phases so files the agent
   * writes outside /logs/agent (e.g. /logs/artifacts) reach the verifier.
   */
  sharedLogs?: boolean;
};

export type TransferSpec =
  | {
      kind: "artifacts";
      workdir: string;
      paths: string[];
      /** Missing sources are recorded in the archive and skipped during restore. */
      optionalPaths?: string[];
      /** Per-source patterns relative to that artifact root, using tar exclusion semantics. */
      excludes?: Record<string, string[]>;
      /** Source files are collected from these services and restored into main. */
      services?: Record<string, string>;
    }
  | {
      kind: "workspace-archive";
      workdir: string;
      extraPaths: string[];
    }
  | {
      /** Export committed changes as a binary Git patch from baseCommit to HEAD. */
      kind: "git-patch";
      workdir: string;
      /** Commit the diff starts from; abbreviated hashes are accepted. */
      baseCommit: string;
      /** Absolute container path the patch is restored to, e.g. /logs/artifacts/model.patch. */
      target: string;
    };

/**
 * Environment-provided replacement for the configured model endpoint. Solvers
 * call the mapped baseUrl instead of reaching the provider directly.
 */
export type ModelEndpointMapping = {
  /** Base URL visible inside the environment, path prefix included. */
  baseUrl: string;
  /** Configured model endpoint the environment forwards to. */
  originEndpoint: string;
};

export type CommandSpec = {
  user?: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Inherit the environment process/container defaults; true when omitted for compatibility. */
  inheritEnv?: boolean;
  /** Pending output retained before consumption; null preserves complete protocol output. Defaults to a bounded diagnostic tail. */
  outputBufferBytes?: number | null;
  input: Uint8Array | null;
};

export type ExitResult = {
  code: number | null;
  signal: string | null;
};

export interface ProcessHandle {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  done: Promise<ExitResult>;
  stop(graceMs: number): Promise<void>;
}

export type TransferArtifact = {
  path: string;
  sha256: string;
  spec: TransferSpec;
  /** Nonfatal export diagnostics, persisted by the caller with its phase. */
  warnings?: Omit<Warning, "phase">[];
};

export interface EnvironmentSession {
  id: string;
  workdir: string;
  agentOutputDir: string;
  /** Environment-local path; use upload/download rather than coordinator filesystem I/O. */
  verifierOutputDir: string;
  metadata: JsonValue;
  runtime?: RuntimeLocation;
  /** Present when an isolated environment maps the model endpoint. */
  modelEndpoint?: ModelEndpointMapping;
  /** Stop writers and reject new work while keeping controlled export available. */
  quiesce?(signal: AbortSignal): Promise<void>;
  /** Finish solver access while preserving the container for collection/shared verification. */
  transitionToVerification?(network: EnvironmentSpec["network"], signal: AbortSignal): Promise<void>;
  /** Stop verification, erase private test material and restore the solve network. */
  transitionToSolve?(network: EnvironmentSpec["network"], signal: AbortSignal, users?: EnvironmentSpec["executionUsers"]): Promise<void>;
  start(command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle>;
  /** Trusted collection only; the Solver continues to execute in main. */
  startService?(service: string, command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle>;
  upload(source: string, target: string, signal: AbortSignal): Promise<void>;
  download(source: string, target: string, signal: AbortSignal): Promise<void>;
  exportState(spec: TransferSpec, target: string, signal: AbortSignal): Promise<TransferArtifact>;
  restoreState(artifact: TransferArtifact, signal: AbortSignal): Promise<void>;
  dispose(signal: AbortSignal): Promise<void>;
}

export interface Environment {
  /** Hold image maintenance off throughout preparation and execution. */
  acquireImageLease?(signal: AbortSignal): Promise<() => Promise<void>>;
  cleanupImages?(request: import("./image-cleanup.js").ImageCleanupRequest, signal: AbortSignal): Promise<import("./image-cleanup.js").ImageCleanupNode>;
  /** Prepare shared dependencies without creating an attempt or task container. */
  materialize?(spec: EnvironmentSpec, signal: AbortSignal, onImageReady?: (timing: EnvironmentImageReady) => void, activity?: ActivityListener, context?: EnvironmentPreparationContext): Promise<EnvironmentSpec>;
  supportsRuntimeInstallation?: boolean;
  /** Reclaim only these stale attempts after the run writer lock is held. */
  recoverAttempts?(keys: AttemptKey[], signal: AbortSignal): Promise<void>;
  /**
   * Prepare the task-independent part of a solver runtime ahead of the timed
   * environment phase; attempts share it and prepare() must not depend on it.
   * The optional task spec supplies target-platform requirements, not task data to install.
   */
  installRuntime?(installation: RuntimeInstallation, signal: AbortSignal, spec?: EnvironmentSpec, activity?: ActivityListener): Promise<void>;
  prepare(
    spec: EnvironmentSpec,
    paths: AttemptPaths,
    phase: "solve" | "verify",
    signal: AbortSignal,
    activity?: ActivityListener,
  ): Promise<EnvironmentSession>;
}
