import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import type { JsonValue } from "../../core/contracts/task.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";

import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";

import { PI_VERSION } from "./agentbundle-runtime.js";

import { projectRunnerInput } from "./protocol.js";
import { consumePiRunner } from "./process.js";

import { type BundlePreparation, sameCandidate, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";
export async function preparePi(
  preparation: BundlePreparation & { piArtifactDigest: string | undefined },
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  if (preparation.options.dshhome !== undefined || preparation.options.dshprofile !== undefined || preparation.options.hermeshome !== undefined) {
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH and Hermes home/profile options are not accepted for Pi bundles");
  }
  const runtime = session.runtime!;
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Pi AgentBundle requires an environment-prepared state directory");
  const local = runtime.persistent;
  const path = local ? join : posix.join;
  const node = local ? process.execPath : "node";
  const settings = preparation.options.pi?.settings ?? {};
  const identity = createHash("sha256")
    .update(canonicalJson({ kind: "pi", candidate, runtime: runtime.identity, settings } as JsonValue))
    .digest("hex");
  let state = path(stateRoot, identity.slice(0, 24));
  let home = path(state, "home");
  const cli = path(runtime.root, "agentbundle", "run.mjs");
  const runner = path(runtime.root, "dist", "runtimes", "pi", "runner.js");
  const bundle = path(runtime.root, "bundle");
  const profile = "pi";
  const env = {
    ...(local ? runtimeProcessEnvironment() : { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }),
    HOME: state,
    USERPROFILE: state,
    AGENT_BUNDLE_REGISTRY: path(state, "registry.json"),
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", PI_VERSION],
    cwd: runtime.root,
    env: preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env,
    inheritEnv: false,
    input: null,
  });
  const release = local
    ? await acquireRuntimeLock(join(stateRoot, `${identity}.lock`), context.signal)
    : async () => {};
  try {
    if (local) state = await claimPersistentState(stateRoot, state, identity);
    home = path(state, "home");
    env.HOME = home;
    env.USERPROFILE = home;
    env.AGENT_BUNDLE_REGISTRY = path(state, "registry.json");
    const verified = parseVerifiedBundle(
      await cliJson(start, command(["verify", bundle, "--expect-digest", candidate.digest]), context.signal),
    );
    sameCandidate(candidate, verified);
    const installed = parseInstalledBundle(
      await cliJson(start, command(["install", bundle, "--home", home, "--profile", profile]), context.signal),
    );
    sameCandidate(candidate, installed);
    if (installed.home !== home || installed.profile !== profile || installed.codingAgentDir === undefined)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI did not return the requested Pi home/profile/config directory");
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(
      join(context.paths.agent, "installation.json"),
      JSON.stringify({
        ...installed,
        runtimeIdentity: runtime.identity,
        preparationIdentity: identity,
        artifactDigest: preparation.piArtifactDigest,
      }),
      { mode: 0o600 },
    );
    const codingAgentDir = installed.codingAgentDir;
    return preparedAttempt(
      release,
      async (input, signal) => {
        const mapping = session.modelEndpoint;
        const model = mapping && preparation.model.endpoint === mapping.originEndpoint
          ? { ...preparation.model, endpoint: mapping.baseUrl }
          : preparation.model;
        const runnerInput = projectRunnerInput({
          key: context.key,
          input,
          model,
          auth: preparation.auth,
          workdir: session.workdir,
          outputDir: session.agentOutputDir,
          piConfigDir: codingAgentDir,
          piSettings: settings,
        });
        return start(
          {
            executable: node,
            args: [runner],
            cwd: session.workdir,
            env: {},
            input: Buffer.from(`${JSON.stringify(runnerInput)}\n`, "utf8"),
          },
          signal,
        );
      },
      (handle, solveContext, signal) =>
        consumePiRunner(handle, preparation.auth.value, join(solveContext.paths.agent, "stderr.log"), signal, solveContext.warning, solveContext.activity),
    );
  } catch (error) {
    await release();
    throw error;
  }
}
