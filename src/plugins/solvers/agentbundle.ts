import { rm } from "node:fs/promises";
import { sameCandidate } from "../../runtimes/agentbundle/preparation-state.js";
import { preparePi } from "../../runtimes/pi/prepare.js";
import { prepareJiuwenswarm, prepareJiuwenswarmDocker } from "../../runtimes/jiuwenswarm/prepare.js";
import { prepareHermes } from "../../runtimes/hermes/prepare.js";
import { prepareDsh } from "../../runtimes/dsh/prepare.js";
import { prepareDify } from "../../runtimes/dify/prepare.js";
import { parseDifyOptions, type DifyOptions } from "../../runtimes/dify/config.js";
import { DIFY_RUNNER_VERSION, difyRuntimeInstallation } from "../../runtimes/dify/runtime.js";
import { prepareDeepagentsDocker, prepareDeepagentsLocal } from "../../runtimes/deepagents/prepare.js";
import { createHash } from "node:crypto";

import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import type { EnvironmentSession, RuntimeInstallation, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { JsonValue, PublicTask } from "../../core/contracts/task.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, type VerifiedBundle } from "../../runtimes/agentbundle/cli.js";
import { DSH_VERSION, describeDshBundleRuntime, type DshBundleRuntime } from "../../runtimes/dsh/runtime.js";
import { AGENT_BUNDLE_CORE_VERSION, assertHarnessVersionCompatible, verifyBundleCandidate } from "../../runtimes/agentbundle/sdk.js";

import { DEEPAGENTS_VERSION, deepagentsBundleRuntimeInstallation, deepagentsPythonProvenance } from "../../runtimes/deepagents/runtime.js";
import { HERMES_VERSION, hermesRuntimeInstallation } from "../../runtimes/hermes/runtime.js";

import { JIUWENSWARM_VERSION, jiuwenswarmBundleRuntimeInstallation } from "../../runtimes/jiuwenswarm/runtime.js";
import { PI_VERSION, describePiBundleRuntime, disposePiBundleRuntime, type PiBundleRuntime } from "../../runtimes/pi/agentbundle-runtime.js";
import { verifyPiBundleIntegrity } from "../../runtimes/pi/integrity.js";

type DshOptions = { dshhome?: string; dshprofile?: string; environmentName?: string };
type HermesOptions = { hermeshome?: string };
type JiuwenswarmOptions = { jiuwenswarmhome?: string; jiuwenswarmTimeoutSeconds?: number };
type PiOptions = { pi?: { settings?: Record<string, JsonValue> } };
type HarnessOptions = DshOptions & HermesOptions & JiuwenswarmOptions & PiOptions & { dify?: DifyOptions };

export function parseAgentBundleConfig(
  value: unknown,
): { path: string; maxTokens?: number } & HarnessOptions {
  const config = expectRecord(value, "agentbundle");
  rejectUnknown(config, ["path", "dshhome", "dshprofile", "maxTokens", "hermeshome", "jiuwenswarmhome", "jiuwenswarmTimeoutSeconds", "pi", "dify"], "agentbundle");
  const result: { path: string; maxTokens?: number } & HarnessOptions = {
    path: expectNonEmptyString(config.path, "agentbundle.path"),
  };
  if (config.maxTokens !== undefined) result.maxTokens = expectPositiveInteger(config.maxTokens, "agentbundle.maxTokens");
  if (config.dshhome !== undefined) result.dshhome = expectNonEmptyString(config.dshhome, "agentbundle.dshhome");
  if (config.dshprofile !== undefined) {
    result.dshprofile = expectNonEmptyString(config.dshprofile, "agentbundle.dshprofile");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(result.dshprofile))
      throw new TypeError("agentbundle.dshprofile must match /^[a-z0-9][a-z0-9-]*$/");
  }
  if (config.hermeshome !== undefined) result.hermeshome = expectNonEmptyString(config.hermeshome, "agentbundle.hermeshome");
  if (config.jiuwenswarmhome !== undefined)
    result.jiuwenswarmhome = expectNonEmptyString(config.jiuwenswarmhome, "agentbundle.jiuwenswarmhome");
  if (config.jiuwenswarmTimeoutSeconds !== undefined)
    result.jiuwenswarmTimeoutSeconds = expectPositiveInteger(config.jiuwenswarmTimeoutSeconds, "agentbundle.jiuwenswarmTimeoutSeconds");
  if (config.pi !== undefined) {
    const pi = expectRecord(config.pi, "agentbundle.pi");
    rejectUnknown(pi, ["settings"], "agentbundle.pi");
    if (pi.settings === undefined) result.pi = {};
    else {
      const settings = expectRecord(pi.settings, "agentbundle.pi.settings");
      assertJsonValue(settings, "agentbundle.pi.settings");
      result.pi = { settings };
    }
  }
  if (config.dify !== undefined) result.dify = parseDifyOptions(config.dify);
  return result;
}

/**
 * The solver's service model with `agentbundle.maxTokens` applied. Hosts that
 * inject services without generation limits, such as the RSI Runner, bound the
 * harness's per-response output here.
 */
export function agentBundleModel(model: ModelConfig, maxTokens: number | undefined, service: string): ModelConfig {
  if (maxTokens === undefined) return model;
  if (model.maxTokens !== undefined)
    throw new TypeError(`agentbundle.maxTokens conflicts with services.${service}.maxTokens; declare it in one place`);
  return { ...model, maxTokens };
}

type RuntimeAdapter = { installation(harness: string, signal: AbortSignal): Promise<RuntimeInstallation> };

/** Harness name → the exact version the evaluator pins and probes for. */
const SUPPORTED_HARNESSES: Record<string, string> = {
  dsh: DSH_VERSION,
  deepagents: DEEPAGENTS_VERSION,
  hermes: HERMES_VERSION,
  jiuwenswarm: JIUWENSWARM_VERSION,
  pi: PI_VERSION,
};

/**
 * Local harnesses have pinned versions. Remote Dify records its declared range
 * separately because the runner version does not identify the platform version.
 */
async function resolveHarnessVersion(name: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  return SUPPORTED_HARNESSES[name];
}

export class AgentBundleSolver implements Solver {
  private candidate: VerifiedBundle | undefined;
  private installationIdentity: string | undefined;
  private harnessVersion: string | undefined;
  private readonly piRuntime: PiBundleRuntime = {};
  private piArtifactDigest: string | undefined;
  private piConfigurationDigest: string | undefined;
  private dshRuntime: DshBundleRuntime | undefined;

  constructor(
    private readonly path: string,
    private readonly model: ModelConfig,
    private readonly auth: RuntimeAuth,
    private readonly adapter: RuntimeAdapter | undefined = undefined,
    private readonly options: HarnessOptions = {},
    private readonly network?: import("../../core/contracts/network.js").NetworkAccess,
  ) {}

  async dispose(): Promise<void> {
    try {
      await disposePiBundleRuntime(this.piRuntime);
    } finally {
      const directory = this.dshRuntime?.directory;
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }

  private async installation(harness: VerifiedBundle["harness"], signal: AbortSignal, lockedVersion?: string): Promise<RuntimeInstallation> {
    if (this.adapter) return this.adapter.installation(harness.name, signal);
    if (harness.name === "dify") return difyRuntimeInstallation(signal);
    if (harness.name === "deepagents") return deepagentsBundleRuntimeInstallation(this.path, this.options.environmentName, signal);
    if (harness.name === "jiuwenswarm") return jiuwenswarmBundleRuntimeInstallation(this.path, this.options.environmentName, signal);
    if (harness.name === "hermes") return hermesRuntimeInstallation(signal, this.network);
    if (harness.name === "pi") return describePiBundleRuntime(this.path, this.piArtifactDigest, this.piConfigurationDigest, this.piRuntime, signal);
    this.dshRuntime = await describeDshBundleRuntime(
      this.options.environmentName, signal, harness.versionRange, this.dshRuntime, this.network, lockedVersion,
    );
    return this.dshRuntime.installation;
  }

  requirements(): RuntimeRequirement[] {
    // Hermes and jiuwenswarm are host binaries (Python); only the vendored CLI
    // needs node, and that runs under process.execPath in local mode. A docker
    // jiuwenswarm prepare runs that CLI from the image's node instead, so this
    // one combination declares node the way DSH and deepagents do. DSH and
    // deepagents pin node 24.
    const harness = this.candidate?.harness.name;
    if (harness === "dify") return [{ name: "node", version: "24.x", platform: "any" }];
    if (harness === "hermes" || harness === "jiuwenswarm" && this.options.environmentName !== "docker")
      return [{ name: "shell", version: "any", platform: "any" }];
    return [
      { name: "node", version: "24.x", platform: "any" },
      { name: "shell", version: "any", platform: "any" },
    ];
  }

  async provenance(signal: AbortSignal, previous?: SolverProvenance): Promise<SolverProvenance> {
    signal.throwIfAborted();
    const identified = await verifyBundleCandidate(this.path);
    const dify = identified.harness.name === "dify";
    if (!dify && SUPPORTED_HARNESSES[identified.harness.name] === undefined)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", `unsupported harness: ${identified.harness.name}`);
    if (dify && this.options.dify === undefined)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Dify bundles require agentbundle.dify.baseUrl");
    if (!dify && this.options.dify !== undefined)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle.dify settings are only accepted for Dify bundles");
    if (identified.harness.name === "pi") {
      this.piArtifactDigest = await verifyPiBundleIntegrity(this.path);
      this.piConfigurationDigest = createHash("sha256")
        .update(canonicalJson((this.options.pi?.settings ?? {}) as JsonValue))
        .digest("hex");
    } else if (this.options.pi !== undefined) {
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle.pi settings are only accepted for pi bundles");
    }
    const lockedVersion = previous?.bundle === identified.digest && previous.harness === "dsh"
      ? previous.harnessVersion : undefined;
    const installation = await this.installation(identified.harness, signal, lockedVersion);
    const harnessVersion = identified.harness.name === "dsh" && this.dshRuntime
      ? this.dshRuntime.version
      : await resolveHarnessVersion(identified.harness.name, signal);
    if (!dify && harnessVersion === undefined)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", `unsupported harness: ${identified.harness.name}`);
    if (harnessVersion !== undefined) assertHarnessVersionCompatible(harnessVersion, identified.harness.versionRange);
    const reverified = await verifyBundleCandidate(this.path, identified.digest);
    if (reverified.harness.name !== identified.harness.name || reverified.digest !== identified.digest) {
      throw new AgentBundleError("SOURCE_CHANGED", "bundle changed while identifying the harness");
    }
    const candidate: VerifiedBundle = {
      ...reverified,
      harness: { ...reverified.harness, ...(harnessVersion === undefined ? {} : { actualVersion: harnessVersion }) },
    };
    signal.throwIfAborted();
    if (this.candidate) sameCandidate(this.candidate, candidate);
    this.candidate = candidate;
    if (this.installationIdentity !== undefined && installation.id !== this.installationIdentity) {
      throw new AgentBundleError("SOURCE_CHANGED", "solver runtime assets changed after the run was locked");
    }
    this.installationIdentity = installation.id;
    this.harnessVersion = harnessVersion;
    const provenance: SolverProvenance = {
      bundle: candidate.digest,
      harness: candidate.harness.name,
      ...(harnessVersion === undefined ? {} : { harnessVersion }),
      cliVersion: AGENT_BUNDLE_CORE_VERSION,
      installation: installation.id,
    };
    if (dify) {
      provenance.harnessVersionRange = candidate.harness.versionRange;
      provenance.runnerVersion = DIFY_RUNNER_VERSION;
    }
    if (identified.harness.name === "pi") {
      const artifact = this.piArtifactDigest;
      const configuration = this.piConfigurationDigest;
      if (artifact === undefined || configuration === undefined) {
        throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Pi bundle identity was not retained after verification");
      }
      provenance.artifact = artifact;
      provenance.configuration = configuration;
    }
    if (identified.harness.name === "deepagents") {
      provenance.pythonRuntime = await deepagentsPythonProvenance(this.options.environmentName, signal);
    }
    return provenance;
  }

  async runtimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
    if (!this.candidate) await this.provenance(signal);
    const candidate = this.candidate;
    if (candidate === undefined)
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "agentbundle did not lock a candidate identity");
    const installation = await this.installation(candidate.harness, signal);
    if (installation.id !== this.installationIdentity)
      throw new AgentBundleError("SOURCE_CHANGED", "solver runtime assets changed after the run was locked");
    return installation;
  }

  async prepare(session: EnvironmentSession, context: AttemptContext): Promise<PreparedSolver> {
    if (!this.candidate) await this.provenance(context.signal);
    const candidate = this.candidate;
    const runtime = session.runtime;
    if (candidate?.harness.name === "dify" && this.options.dify !== undefined)
      return prepareDify(this.path, this.options.dify, session, context, candidate);
    if (!candidate || !runtime?.stateRoot)
      throw new AgentBundleError(
        "ENV_RUNTIME_INSTALL_FAILED",
        "agentbundle requires an environment-prepared runtime and state directory",
      );
    const bundle = { network: this.network, path: this.path, model: this.model, auth: this.auth, options: this.options,
      harnessVersion: this.harnessVersion };
    if (candidate.harness.name === "deepagents") {
      if (this.options.environmentName === "docker") return prepareDeepagentsDocker(bundle, session, context, candidate);
      return prepareDeepagentsLocal(bundle, session, context, candidate);
    }
    if (candidate.harness.name === "hermes") return prepareHermes(bundle, session, context, candidate);
    if (candidate.harness.name === "jiuwenswarm") {
      if (this.options.environmentName === "docker") return prepareJiuwenswarmDocker(bundle, session, context, candidate);
      return prepareJiuwenswarm(bundle, session, context, candidate);
    }
    if (candidate.harness.name === "pi") return preparePi({ ...bundle, piArtifactDigest: this.piArtifactDigest }, session, context, candidate);
    return prepareDsh({ ...bundle, ...(this.dshRuntime?.localDsh ? { localDsh: this.dshRuntime.localDsh } : {}) }, session, context, candidate);
  }

  async solve(_input: PublicTask, _session: EnvironmentSession, _context: AttemptContext): Promise<SolveResult> {
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle must be executed through its prepared attempt handle",
    );
  }
}
