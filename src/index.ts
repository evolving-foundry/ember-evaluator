export type * from "./core/contracts/hardware.js";
export type * from "./core/contracts/task.js";
export type * from "./core/contracts/result.js";
export type * from "./core/contracts/errors.js";
export { EvaluatorError } from "./core/errors/evaluator-error.js";
export { VerificationError } from "./core/errors/verification-error.js";
export { ERROR_CODES, type ErrorCode, type ErrorDefinition } from "./core/errors/registry.js";
export { classifyError, normalizeFailure, type ErrorContext } from "./core/errors/classify.js";
export { failureDecision } from "./core/policies/error-policy.js";
export type * from "./core/contracts/benchmark.js";
export type * from "./core/contracts/environment.js";
export type * from "./core/contracts/image-cleanup.js";
export type * from "./core/contracts/solver.js";
export type * from "./core/contracts/metrics.js";
export type * from "./core/contracts/reporter.js";
export type * from "./core/contracts/run-store.js";
export type * from "./core/contracts/scheduler.js";
export type * from "./core/contracts/preparation.js";
export { createPreparationRound, runPreparationRound } from "./core/preparation/preparation-round.js";
export type * from "./core/contracts/verifier.js";
export type * from "./core/contracts/config-transport.js";
export type * from "./core/contracts/verification-runtime.js";
export type { CliOverrides, ModelConfig, Selection, SolverSelection, VerifierSelection, EffectiveConfig, RuntimeAuth } from "./core/contracts/config.js";
export type { DEFAULT_LOCAL_CONCURRENCY, DEFAULT_METRICS, KNOWN_APIS, KNOWN_PROVIDERS } from "./config/defaults.js";
export type { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectPositiveNumber, expectRecord, parseSelection, rejectUnknown } from "./core/validation/input.js";
export type { assertServiceBindings, solverBinding } from "./core/policies/service-bindings.js";
export type { LoadedConfig } from "./config/loaded.js";
export { loadConfig } from "./application/config.js";
export { resolveConfig } from "./config/resolve.js";
export type { ConfigOrigins, ConfigResolution } from "./config/resolve.js";
export { parseUserConfig } from "./config/user-schema.js";
export type { UserConfig, ServiceInput, BenchmarkSelection, PluginSelection, EnvironmentInput, SchedulerInput } from "./config/user-schema.js";
export { readProfileDirectory } from "./infrastructure/profiles/read.js";
export { parseConfigProfile } from "./config/profile-schema.js";
export type { ConfigProfile, ProfileDefaults, ProfileLayer, ProfileRole, ResolvedProfiles } from "./config/profile-schema.js";
export { redactSecrets } from "./config/redact.js";
export { redactDiagnostic } from "./core/errors/diagnostics.js";
export type { PluginConfigValidator, PluginFactory, PluginFactoryContext, PluginRole, PreparedPlugin, RoleImplementations } from "./core/contracts/plugin.js";
export { bootstrap } from "./application/plugins/bootstrap.js";
export { Evaluator, EvaluatorRunError, type EvaluationResult, type EvaluatorRunOptions } from "./application/evaluator.js";
export type { ProgressEvent, ProgressListener, LiveProgress } from "./core/progress/progress.js";
export type * from "./core/contracts/activity.js";
export type * from "./core/contracts/components.js";
// Reusable authoring helpers used by independently packaged protocol plugins.
export { buildFileManifest } from "./core/artifacts/artifacts.js";
export { fingerprintConfig } from "./core/results/run-manifest.js";
export { assertSourceLock } from "./core/results/source-lock.js";
export { checkedPath, evidencePath } from "./core/artifacts/artifacts.js";
export { DatasetCache } from "./infrastructure/datasets/cache.js";
export { withDatasetActivity } from "./infrastructure/datasets/activity.js";
export { GitBlobCache, gitBlobHash } from "./infrastructure/datasets/sources/github/blob-cache.js";
export { parseGitTree, type GitTreeEntry } from "./infrastructure/datasets/sources/github/tree.js";
export { writeGitFile } from "./infrastructure/datasets/sources/github/files.js";
export { GitLfsCache, parseGitLfsPointer, type GitLfsObject } from "./infrastructure/datasets/sources/git-lfs.js";
export { GitHubLfsSource, type GitHubLfsSourceOptions, type GitHubLfsTransport } from "./infrastructure/datasets/sources/github/lfs.js";
export { DockerImageArchiveLoader, type DockerImageArchive } from "./infrastructure/containers/image-archive.js";
export { readRows } from "./infrastructure/datasets/input-readers/rows.js";
export type { DatasetRecordSource } from "./infrastructure/datasets/record-source.js";
export { DefinedBenchmark } from "./plugins/benchmarks/agent-harness/definitions/defined-benchmark.js";
export { planBenchmarkRun } from "./plugins/benchmarks/shared/plan-run.js";
export type { BenchmarkDefinition, BenchmarkRecord, DefinedTask, BenchmarkDefinitionContext } from "./plugins/benchmarks/agent-harness/definitions/benchmark-definition.js";
export { DockerEnvironment, type DockerEnvironmentOptions } from "./plugins/environments/docker/environment.js";
export { PINNED_NODE_IMAGE, type DockerCommand } from "./infrastructure/containers/runtime-contract.js";
export { runDockerCommand } from "./infrastructure/containers/command.js";
export { runEngine, type EngineInput } from "./application/run-engine.js";
export { rebuildReport, saveReport } from "./application/report/index.js";
export { SimpleAgentSolver, SimpleAgentError } from "./plugins/solvers/simpleagent.js";
export { AgentBundleSolver, parseAgentBundleConfig } from "./plugins/solvers/agentbundle.js";
export { AgentBundleError } from "./runtimes/agentbundle/cli.js";
export {
  HarborBenchmark,
  createHarborSource,
  parseHarborConfig,
  type HarborConfig,
  type HarborTransport,
} from "./plugins/benchmarks/agent-harness/protocols/harbor/index.js";
export { validateStateProfile, HarborTaskError, type HarborStateProfile } from "./plugins/benchmarks/agent-harness/protocols/harbor/compatibility.js";
export { TransferClient, removeUploadedAttempt, type TransferClientOptions } from "./infrastructure/transfer/client.js";
export { DirectoryReceiver, type AcceptUpload } from "./infrastructure/transfer/receiver.js";
export { startTransferReceiver, type ReceiverServerOptions } from "./infrastructure/transfer/https.js";
export {
  TransferError,
  validateUploadManifest,
  validateReceipt,
  uploadDigest,
  type UploadManifest,
  type UploadReceipt,
} from "./infrastructure/transfer/protocol.js";
export { createDistributedReceiver } from "./plugins/stores/distributed-receiver.js";

export { parseDockerPlatform, resolveDockerPlatform, PlatformCapabilityDetector, type DockerPlatformSelection, type PlatformResolution } from "./infrastructure/containers/platform.js";
export type { Verifier, VerificationTask, VerificationEvidence } from "./core/contracts/verifier.js";
export { HarborShellVerifier, parseRewardEvidence } from "./plugins/verifiers/shell.js";
export { HarborPythonVerifier, parsePythonVerifierConfig } from "./plugins/verifiers/python/index.js";
export { loadGenericHarborTask } from "./plugins/benchmarks/agent-harness/protocols/harbor/task.js";

export { identifyNetworkFailure, type NetworkStage, type NetworkEvidence } from "./core/errors/network-failure.js";
export type { NetworkAccess, NetworkDocument, NetworkSettings, NetworkProxy, NetworkLocation, NetworkSnapshot, ImageAcquisition, ImageRequestContext } from "./core/contracts/network.js";
export { resolveRunStatus } from "./core/results/task-result-resolver.js";
export type { ReportingFactoryContext, FactoryContext, ServiceBinding } from "./core/contracts/plugin.js";
export type { Deployment } from "./config/deployment.js";

export { bindService, bindSolverService } from "./core/contracts/plugin.js";

export { attemptStatus, attemptTimeoutKind } from "./core/results/evaluation-outcome.js";

export { parseKernelContract, parseKernelAssessment, kernelContractDigest, KERNEL_CHECK_IDS, KERNEL_ENVIRONMENT_FIELDS } from "./plugins/benchmarks/operator/kernel/strict.js";
export type { KernelContract, KernelAssessment, KernelCheck, KernelEffectiveProtocol, KernelEnvironment } from "./plugins/benchmarks/operator/kernel/strict.js";

export { parseKernelTimingEvidence, auditKernelTimingSample } from "./plugins/benchmarks/operator/kernel/timing.js";
export type { KernelTimingEvidence, KernelTimingSample, KernelTimingRow } from "./plugins/benchmarks/operator/kernel/timing.js";
