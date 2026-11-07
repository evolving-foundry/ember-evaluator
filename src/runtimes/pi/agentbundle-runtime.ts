import { createHash } from "node:crypto";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe } from "../agentbundle/runtime-files.js";
import { AGENT_BUNDLE_CORE_VERSION } from "../agentbundle/sdk.js";
import { disposePiBundle, stagePiBundle, type StagedPiBundle } from "./bundle.js";
import { createPiRuntimeInstallation } from "./package-runtime.js";
import { verifyPiBundleIntegrity } from "./integrity.js";
import { AgentBundleError } from "../agentbundle/cli.js";

export type PiBundleRuntime = { staged?: Promise<StagedPiBundle> };

export function disposePiBundleRuntime(state: PiBundleRuntime): Promise<void> {
  return disposePiBundle(state.staged);
}

export async function describePiBundleRuntime(
  path: string, artifact: string | undefined, configuration: string | undefined,
  state: PiBundleRuntime, signal: AbortSignal,
): Promise<RuntimeInstallation> {
  if (artifact === undefined || configuration === undefined)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Pi bundle identity must be verified before preparing its runtime");
  state.staged ??= stagePiBundle({ path }, signal);
  const staged = await state.staged;
  if (await verifyPiBundleIntegrity(staged.bundlePath) !== artifact)
    throw new AgentBundleError("SOURCE_CHANGED", "Pi bundle changed while staging its runtime");
  return piAgentBundleRuntimeInstallation(signal, staged, artifact, configuration);
}

export const PI_VERSION = "0.1.0";

export async function piAgentBundleRuntimeInstallation(
  signal: AbortSignal,
  bundle: StagedPiBundle,
  artifactDigest: string,
  configurationDigest: string,
): Promise<RuntimeInstallation> {
  const pi = await createPiRuntimeInstallation(signal, bundle);
  const agentbundleFiles = await agentBundleRuntimeFiles();
  const id = createHash("sha256")
    .update(pi.id)
    .update("\0")
    .update(AGENT_BUNDLE_CORE_VERSION)
    .update("\0")
    .update(artifactDigest)
    .update("\0")
    .update(configurationDigest)
    .digest("hex");
  return {
    id: `pi-agentbundle:${id}`,
    cacheName: `pi-bundle-${PI_VERSION}`,
    files: [...pi.files, ...agentbundleFiles],
    commands: pi.commands,
    probes: [...pi.probes, agentBundleVersionProbe()],
  };
}
