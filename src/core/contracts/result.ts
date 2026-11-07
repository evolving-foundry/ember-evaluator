import type { JsonValue, SourceLock } from "./task.js";
import type { SolverProvenance } from "./solver.js";
import type { EnvironmentPreparationTimings } from "./environment.js";
import type { ErrorMetadata } from "./errors.js";
import type { ErrorCode } from "../errors/registry.js";

export type EvaluationKind = "quality" | "performance";

export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type SolveResult = {
  finalText: string;
  usage: Usage;
  /** Versioned, credential-free observations for verification and offline metrics. */
  observations?: JsonValue;
};

/** Attempt-relative path of the collected solver trajectory. */
export const TRAJECTORY_EVIDENCE_PATH = "agent/trajectory.jsonl";

export type VerifyResult = {
  /**
   * Optional benchmark-specific reward. Absence means "no score measured", never zero;
   * correctness is carried by `passed` and aggregate metrics must not treat a missing score as 0.
   */
  score?: number;
  /** null means binary correctness was not measured. Performance results must also omit score. */
  passed: boolean | null;
  details: JsonValue;

};

export type AttemptKey = {
  runId: string;
  taskId: string;
  attemptId: string;
};

export type AttemptPaths = {
  root: string;
  agent: string;
  verifier: string;
  artifacts: string;
};

export type Phase = "prepare" | "install" | "environment" | "solve" | "transfer" | "verify" | "collect" | "cleanup" | "store";

export type Failure = {
  phase: Phase;
  code: ErrorCode;
  message: string;
} & ErrorMetadata;

/** Nonfatal diagnostics have no retry or dispatch policy. */
export type Warning = Pick<Failure, "phase" | "code" | "message">;

export type Collection = {
  trajectory: "complete" | "partial" | "missing" | "not-produced";
  artifacts: "complete" | "partial" | "missing" | "not-produced";
};

export type AttemptRecord = {
  steps?: AttemptStepResult[];
  key: AttemptKey;
  evaluationKind: EvaluationKind;
  executionStatus: "completed" | "agent_timeout" | "failed" | "cancelled";
  scoreStatus: "valid" | "invalid" | "not-applicable";
  cleanupStatus: "cleaned" | "unconfirmed";
  accounting?: { usage: Usage; cost: number | null; currency: string | null; complete: boolean };
  solve: SolveResult | null;
  verdict: VerifyResult | null;
  errors: Failure[];
  /** Nonfatal diagnostics; absent in historical records. */
  warnings?: Warning[];
  collection: Collection;
  /**
   * Present whenever the trajectory file was collected, with or without a verdict
   * (e.g. a solve timeout keeps its partial trajectory); absent in historical records.
   */
  trajectory?: typeof TRAJECTORY_EVIDENCE_PATH;
  environments: { solve: JsonValue; verify: JsonValue; verificationRuntime?: JsonValue };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  phaseDurationMs: Partial<Record<Phase, number>>;
  /** Admission delay after this task's environments were ready; absent in historical attempts. */
  readiness?: { roundId: string; readyAt: string; queueDurationMs: number };
  /** Original prompt and, when the benchmark has one, its textual reference answer. */
  task?: { prompt: string; answer?: JsonValue };
};

export type AttemptStepResult = {
  accounting?: NonNullable<AttemptRecord["accounting"]>;
  name: string;
  solve: SolveResult | null;
  verdict: VerifyResult | null;
  errors: Failure[];
  startedAt: string;
  finishedAt: string;
  evidencePath: string;
};

export type FileEntry = {
  path: string;
  size: number;
  sha256: string;
};

export type FileManifest = {
  files: FileEntry[];
  missing: { path: string; reason: string }[];
};

export type RemoteAttemptState = {
  key: AttemptKey;
  nodeId: string | null;
  hostname: string | null;
  state: "queued" | "running" | "uploading" | "collected" | "uncollected" | "quarantined";
  transferId: string | null;
  receipt: string | null;
  message: string | null;
};
export type RemoteAttemptUpdate = Pick<RemoteAttemptState, "key" | "state"> &
  Partial<Omit<RemoteAttemptState, "key" | "state">>;

/** Actual evaluator implementation and host runtime that produced a run; absent in historical runs. */
export type RunIdentity = {
  evaluator: { name: string; version: string };
  runtime: { node: string; platform: string; arch: string };
};

export type RunManifest = {
  schemaVersion: 1;
  evaluationKind: EvaluationKind;
  /** Absent in historical results; incompatible execution versions cannot resume. */
  executionVersion?: 2;
  preparationRounds?: PreparationRound[];
  runId: string;
  source: SourceLock | null;
  failure?: Failure | null;
  initializationFailures?: Failure[];
  taskIds: string[];
  configFingerprint: string;
  /** Credential-free runtime selections for human-readable reporting. */
  configSummary?: JsonValue;
  /** Evaluator package and runtime identity for downstream measurement conditions. */
  identity?: RunIdentity;
  solverProvenance?: SolverProvenance;
  pluginVersions: Record<string, string>;
  /** Coordination diagnostics; uncollected work has no fabricated score. */
  remoteAttempts?: RemoteAttemptState[];
  /** Patch source metadata for offline reporting; never required by a worker. */
  pluginRuntime?: {
    configDirectory: string;
    /** Absolute patch file path used for offline plugin reloads on this host. */
    patchPath?: string;
    /** Original Ray Jobs coordinator paths when the downloaded run was localized. */
    coordinatorConfigDirectory?: string;
    coordinatorPatchPath?: string;
    entries: { id: string; name: string }[];
    reportingProviders?: Record<string, string>;
    /** Activated extensions and credential-free options, restored for resume/retry. */
    plugins?: import("./plugin-extension.js").PluginActivation[];
  };
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: "running" | "completed" | "cancelled" | "error";
};

export type PreparationStageTiming = {
  /** Active preparation time spent in earlier calls, excluding intervening execution. */
  elapsedMs?: number;
  baseSeconds: number;
  concurrency: number;
  multiplier: number;
  timeoutSeconds: number;
  startedAt: string;
  deadlineAt: string;
  finishedAt: string | null;
};

export type TaskPreparationTiming = {
  taskId: string;
  status: "queued" | "preparing" | "ready" | "error" | "cancelled";
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queueDurationMs: number | null;
  durationMs: number | null;
  phaseDurationMs: Partial<Record<"solveEnvironment" | "verifyEnvironment", number>>;
  imagePhaseDurationMs?: { solve?: EnvironmentPreparationTimings; verify?: EnvironmentPreparationTimings };
  environmentTimeouts?: { solve?: PreparationStageTiming; verify?: PreparationStageTiming };
  error?: string;
  failure?: Failure;
};

export type PreparationRound = {
  timeoutPolicy?: "task-concurrency-v1";
  nodeConcurrency?: Record<string, number>;
  mode?: "batch" | "pipeline";
  concurrency?: number;
  lookahead?: number;
  tasks?: TaskPreparationTiming[];
  placements?: { taskId: string; nodeId: string; digest: string }[];
  id: string;
  taskIds: string[];
  /** The multiplier is read only from historical batch policies; new plans never emit it. */
  policy: { version: string; source: string; environmentBuildTimeoutMultiplier?: number };
  budgetSeconds: number | null;
  startedAt: string;
  deadlineAt: string | null;
  finishedAt: string | null;
  status: "preparing" | "ready" | "error" | "cancelled";
  error?: string;
  failure?: Failure;
};

export type AttemptSummary = {
  key: AttemptKey;
  ordinal: number;
  allocatedAt: string;
  record: AttemptRecord | null;
};

export type ResultSnapshot = {
  run: RunManifest;
  records: AttemptRecord[];
  attemptHistory?: AttemptSummary[];
  pendingTaskIds: string[];
  digest: string;
};
