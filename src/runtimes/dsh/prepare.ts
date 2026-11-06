import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, posix } from "node:path";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";
import { DSH_VERSION } from "./runtime.js";

import { DSH_AUTH_ENV, type DshPermissionMode, dshModelPatch, dshPermissionPatch } from "./model.js";
import { consumeDsh } from "./protocol.js";

import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";
import { localDshLauncher, type LocalDsh } from "./local-runtime.js";

import { type BundlePreparation, sameCandidate, customHomeDirectory, writeHomeConfig, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";
export async function prepareDsh(
  preparation: BundlePreparation & { localDsh?: LocalDsh },
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  const runtime = session.runtime!;
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const local = runtime.persistent;
  const path = local ? join : posix.join;
  const node = local ? process.execPath : "node";
  const profile = preparation.options.dshprofile ?? "evaluator";
  // A Docker task container is disposable and verified in an independent
  // session, so the container is the isolation boundary. DSH's host sandbox
  // backends (bwrap, Landlock) are missing from many container kernels, such
  // as Docker Desktop's, where workspace-write would reject every command.
  const permissionMode: DshPermissionMode = local ? "workspace-write" : "danger-full-access";
  const permissionPatch = dshPermissionPatch(permissionMode);
  // Isolated environments expose the model API at a mapped loopback endpoint;
  // the original configured endpoint stays authoritative in run records.
  const mapping = session.modelEndpoint;
  const modelPatch =
    mapping && preparation.model.endpoint === mapping.originEndpoint
      ? dshModelPatch({ ...preparation.model, endpoint: mapping.baseUrl })
      : dshModelPatch(preparation.model);
  // Preserve existing cache identities when the default profile is used.
  const identity = createHash("sha256")
    .update(
      canonicalJson({
        candidate,
        runtime: runtime.identity,
        modelPatch,
        permissions: permissionPatch,
        ...(profile === "evaluator" ? {} : { profile }),
      }),
    )
    .digest("hex");
  // DSH creates deeply nested operation logs. A 96-bit directory keeps the
  // Windows path below legacy mkdir limits; local reuse verifies the full
  // identity marker before the shortened directory is admitted.
  const configuredHome = local ? preparation.options.dshhome : undefined;
  const customHome = configuredHome !== undefined;
  let state =
    configuredHome !== undefined ? await customHomeDirectory(configuredHome) : path(stateRoot, identity.slice(0, 24));
  let home = state;
  let dsh = path(runtime.root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const cli = path(runtime.root, "agentbundle", "run.mjs");
  const systemEnv = local
    ? runtimeProcessEnvironment()
    : { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  const hostPath = Object.entries(systemEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env = {
    ...systemEnv,
    PATH: `${path(runtime.root, "node_modules", ".bin")}${local ? delimiter : ":"}${hostPath}`,
    HOME: home,
    USERPROFILE: home,
    DSH_BIN: dsh,
    DSH_HOME: home,
    DSH_PERMISSION_MODE: permissionMode,
    DSH_TELEMETRY_DISABLED: "1",
    AGENT_BUNDLE_REGISTRY: path(state, "registry.json"),
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", candidate.harness.actualVersion ?? DSH_VERSION],
    cwd: runtime.root,
    env: preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env,
    inheritEnv: false,
    input: null,
  });
  // Explicit homes need a location-based lock: different identities must not
  // concurrently write the same home or its shared model settings.
  const release = local
    ? await acquireRuntimeLock(
        customHome ? path(state, ".evaluator.lock") : path(stateRoot, `${identity}.lock`),
        context.signal,
      )
    : async () => {};
  try {
    if (local) state = await claimPersistentState(customHome ? dirname(state) : stateRoot, state, identity);
    const outputHook = path(runtime.root, "dsh-output-hook.mjs");
    if (local && preparation.localDsh) dsh = await localDshLauncher(preparation.localDsh, state, outputHook);
    home = state;
    env.HOME = home;
    env.DSH_BIN = dsh;
    env.USERPROFILE = home;
    env.DSH_HOME = home;
    env.AGENT_BUNDLE_REGISTRY = path(state, "registry.json");
    const bundle = local ? preparation.path : path(state, "bundle");
    if (!local) await session.upload(preparation.path, bundle, context.signal);
    const verified = parseVerifiedBundle(
      await cliJson(start, command(["verify", bundle, "--expect-digest", candidate.digest]), context.signal),
    );
    sameCandidate(candidate, verified);
    // run.mjs asks the SDK to force the install, so a matching stamp is not reused.
    const installed = parseInstalledBundle(
      await cliJson(start, command(["install", bundle, "--home", home, "--profile", profile]), context.signal),
    );
    sameCandidate(candidate, installed);
    if (installed.home !== home || installed.profile !== profile)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI installed outside the requested home or profile");
    await mkdir(context.paths.agent, { recursive: true });
    const modelFile = join(context.paths.agent, "model.patch.yaml");
    const permissions = join(context.paths.agent, "permissions.patch.yaml");
    await writeFile(modelFile, modelPatch, { mode: 0o600 });
    await writeFile(permissions, permissionPatch, { mode: 0o600 });
    const patch = path(state, "permissions.patch.yaml");
    const modelOverlay = path(state, "model.patch.yaml");
    if (customHome) {
      // This user-selected host directory is outside the environment's
      // managed upload roots; only the local solver writes these two files.
      await writeHomeConfig(modelOverlay, modelPatch);
      await writeHomeConfig(patch, permissionPatch);
    } else {
      await session.upload(modelFile, modelOverlay, context.signal);
      await session.upload(permissions, patch, context.signal);
    }
    context.signal.throwIfAborted();
    await writeFile(
      join(context.paths.agent, "installation.json"),
      JSON.stringify({ ...installed, runtimeIdentity: runtime.identity, preparationIdentity: identity }),
      { mode: 0o600 },
    );
    return preparedAttempt(
      release,
      (input, signal) =>
        start(
          {
            executable: node,
            args: [...(local && preparation.localDsh ? [] : ["--import", outputHook]), dsh, "--profile", profile,
              "--patch", modelOverlay, "--patch", patch, "--json"],
            cwd: session.workdir,
            env: { ...env, [DSH_AUTH_ENV]: preparation.auth.value, EVALUATOR_DSH_OUTPUT_DIR: session.agentOutputDir },
            inheritEnv: false,
            input: Buffer.from(input.prompt),
          },
          signal,
        ),
      (handle, solveContext, signal) => consumeDsh(handle, { ...solveContext, signal, environment: session }, preparation.auth.value),
    );
  } catch (error) {
    await release();
    throw error;
  }
}

  /**
   * Docker deepagents preparation: the venv and bundle were baked into the
   * solver image at build time (design/20260929-01 §2.1), so prepare only
   * cross-checks the image content against the locked candidate, records the
   * installation evidence and returns the in-container solve handle. The image
   * is immutable and the container is single-attempt, so no runtime lock is
   * needed.
   */
