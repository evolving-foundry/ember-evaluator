export type * from "./core/contracts/hardware.js";
export type * from "./core/contracts/task.js";
export type * from "./core/contracts/result.js";
export type * from "./core/contracts/errors.js";
export { EvaluatorError } from "./core/errors/evaluator-error.js";
export { VerificationError } from "./core/errors/verification-error.js";
export { ERROR_CODES, type ErrorCode, type ErrorDefinition } from "./core/errors/registry.js";
export { classifyError, normalizeFailure, type ErrorContext } from "./core/errors/classify.js";
export { failureDecision } from "./core/error-policy.js";
export type * from "./core/contracts/benchmark.js";
export type * from "./core/contracts/environment.js";
export type * from "./core/contracts/image-cleanup.js";
export type * from "./core/contracts/solver.js";
export type * from "./core/contracts/metrics.js";
export type * from "./core/contracts/reporter.js";
export type * from "./core/contracts/run-store.js";
export type * from "./core/contracts/scheduler.js";
export type * from "./core/contracts/preparation.js";
export { createPreparationRound, runPreparationRound } from "./core/preparation-round.js";
export type * from "./core/contracts/verifier.js";
export type * from "./core/contracts/config-transport.js";
export type * from "./core/contracts/verification-runtime.js";
export type * from "./config/schema.js";
export { loadConfig } from "./config/load.js";
export { resolveConfig } from "./config/resolve.js";
export type { ConfigOrigins, ConfigResolution } from "./config/resolve.js";
export { parseUserConfig } from "./config/user-schema.js";
export type { UserConfig, ServiceInput, BenchmarkSelection, PluginSelection, EnvironmentInput, SchedulerInput } from "./config/user-schema.js";
export { readProfileDirectory, parseConfigProfile } from "./config/profiles.js";
export type { ConfigProfile, ProfileDefaults, ProfileLayer, ProfileRole, ResolvedProfiles } from "./config/profiles.js";
export { redactSecrets } from "./config/redact.js";
export { redactDiagnostic } from "./core/diagnostics.js";
export type {
  PluginConfigValidator,
  PluginFactory,
  PluginFactoryContext,
  PluginRole,
  PreparedPlugin,
  RoleImplementations,
} from "./core/registry.js";
export { bootstrap } from "./bootstrap.js";
export { Evaluator, EvaluatorRunError, type EvaluationResult, type EvaluatorRunOptions } from "./evaluator.js";
export type { ProgressEvent, ProgressListener, LiveProgress } from "./core/progress.js";
export type * from "./core/contracts/activity.js";
export type * from "./core/contracts/components.js";
// Reusable authoring helpers used by independently packaged protocol plugins.
export { buildFileManifest } from "./core/artifacts.js";
export { fingerprintConfig } from "./core/run-manifest.js";
export { assertSourceLock } from "./core/source-lock.js";
export { checkedPath, evidencePath } from "./core/artifacts.js";
export { DatasetCache } from "./adapters/datasets/cache.js";
export { withDatasetActivity } from "./adapters/datasets/activity.js";
export { GitBlobCache, gitBlobHash } from "./adapters/datasets/sources/github/blob-cache.js";
export { parseGitTree, type GitTreeEntry } from "./adapters/datasets/sources/github/tree.js";
export { writeGitFile } from "./adapters/datasets/sources/github/files.js";
export { GitLfsCache, parseGitLfsPointer, type GitLfsObject } from "./adapters/datasets/sources/git-lfs.js";
export { GitHubLfsSource, type GitHubLfsSourceOptions, type GitHubLfsTransport } from "./adapters/datasets/sources/github/lfs.js";
export { DockerImageArchiveLoader, type DockerImageArchive } from "./plugins/environments/docker-image-archive.js";
export { readRows } from "./adapters/datasets/input-readers/rows.js";
export type { DatasetRecordSource } from "./adapters/datasets/record-source.js";
export { DefinedBenchmark } from "./plugins/benchmarks/definitions/defined-benchmark.js";
export { planBenchmarkRun } from "./plugins/benchmarks/plan-run.js";
export type { BenchmarkDefinition, BenchmarkRecord, DefinedTask, BenchmarkDefinitionContext } from "./plugins/benchmarks/definitions/benchmark-definition.js";
export { DockerEnvironment, type DockerEnvironmentOptions } from "./plugins/environments/docker.js";
export { PINNED_NODE_IMAGE, type DockerCommand } from "./plugins/environments/docker-runtime.js";
export { runDockerCommand } from "./plugins/environments/docker.js";
export { runEngine, type EngineInput } from "./core/engine.js";
export { rebuildReport, saveReport } from "./report.js";
export { SimpleAgentSolver, SimpleAgentError } from "./plugins/solvers/simpleagent.js";
export { AgentBundleSolver, parseAgentBundleConfig } from "./plugins/solvers/agentbundle.js";
export { AgentBundleError } from "./adapters/agentbundle/cli.js";
export {
  HarborBenchmark,
  createHarborSource,
  parseHarborConfig,
  type HarborConfig,
  type HarborTransport,
} from "./plugins/benchmarks/protocols/harbor/index.js";
export { validateStateProfile, HarborTaskError, type HarborStateProfile } from "./plugins/benchmarks/protocols/harbor/compatibility.js";
export { TransferClient, removeUploadedAttempt, type TransferClientOptions } from "./adapters/transfer/client.js";
export { DirectoryReceiver, type AcceptUpload } from "./adapters/transfer/receiver.js";
export { startTransferReceiver, type ReceiverServerOptions } from "./adapters/transfer/https.js";
export {
  TransferError,
  validateUploadManifest,
  validateReceipt,
  uploadDigest,
  type UploadManifest,
  type UploadReceipt,
} from "./adapters/transfer/protocol.js";
export { createDistributedReceiver } from "./plugins/stores/distributed-receiver.js";

export { parseDockerPlatform, resolveDockerPlatform, PlatformCapabilityDetector, type DockerPlatformSelection, type PlatformResolution } from "./plugins/environments/docker-platform.js";
export type { Verifier, VerificationTask, VerificationEvidence } from "./core/contracts/verifier.js";
export { HarborShellVerifier, parseRewardEvidence } from "./plugins/verifiers/shell.js";
export { HarborPythonVerifier, parsePythonVerifierConfig } from "./plugins/verifiers/python.js";
export { loadGenericHarborTask } from "./plugins/benchmarks/protocols/harbor/task.js";

export { identifyNetworkFailure, type NetworkStage, type NetworkEvidence } from "./core/errors/network-failure.js";
export type { NetworkAccess, NetworkDocument, NetworkSettings, NetworkProxy, NetworkLocation, NetworkSnapshot, ImageAcquisition, ImageRequestContext } from "./core/contracts/network.js";
export { resolveRunStatus } from "./core/task-result-resolver.js";
export type { ReportingFactoryContext, FactoryContext, ServiceBinding } from "./core/registry.js";
export type { Deployment } from "./config/deployment.js";

export { bindService, bindSolverService } from "./core/registry.js";

export { attemptStatus, attemptTimeoutKind } from "./core/evaluation-outcome.js";

export { parseKernelContract, parseKernelAssessment, kernelContractDigest, KERNEL_CHECK_IDS, KERNEL_ENVIRONMENT_FIELDS } from "./plugins/benchmarks/protocols/kernel/strict.js";
export type { KernelContract, KernelAssessment, KernelCheck, KernelEffectiveProtocol, KernelEnvironment } from "./plugins/benchmarks/protocols/kernel/strict.js";

export { parseKernelTimingEvidence, auditKernelTimingSample } from "./plugins/benchmarks/protocols/kernel/timing.js";
export type { KernelTimingEvidence, KernelTimingSample, KernelTimingRow } from "./plugins/benchmarks/protocols/kernel/timing.js";

export type * from "./core/contracts/plugin-extension.js";
