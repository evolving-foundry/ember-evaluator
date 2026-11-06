import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, cliOutput, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";

import { consumeDsh } from "../dsh/protocol.js";
import { deepagentsModelBinding } from "./model.js";
import { DEEPAGENTS_DOCKER_BUNDLE_TARGET, DEEPAGENTS_DOCKER_HOME_TARGET, DEEPAGENTS_VERSION } from "./runtime.js";

import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";

import { type BundlePreparation, sameCandidate, hasCode, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";

function assertOptions(options: BundlePreparation["options"]): void {
  if (options.dshhome !== undefined || options.dshprofile !== undefined) {
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "dshhome and dshprofile configure the DSH harness and are not accepted for deepagents bundles",
    );
  }
}

export async function prepareDeepagentsDocker(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  assertOptions(preparation.options);
  const runtime = session.runtime!;
  if (runtime.persistent)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "deepagents docker preparation requires the docker environment");
  const root = runtime.root;
  const bundle = posix.join(root, DEEPAGENTS_DOCKER_BUNDLE_TARGET);
  const home = posix.join(root, DEEPAGENTS_DOCKER_HOME_TARGET);
  const python = posix.join(home, "bin", "python");
  const runner = posix.join(root, "deepagents", "runner.py");
  const containerEnv = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: "node",
    args: [posix.join(root, "agentbundle", "run.mjs"), "--json", ...args, "--harness-version", DEEPAGENTS_VERSION],
    cwd: root,
    env: preparation.network?.environment("runtime", containerEnv, "container") ?? containerEnv,
    inheritEnv: false,
    input: null,
  });
  const verified = parseVerifiedBundle(
    await cliJson(start, command(["verify", bundle, "--expect-digest", candidate.digest]), context.signal),
  );
  sameCandidate(candidate, verified);
  const probed = (
    await cliOutput(
      start,
      {
        executable: python,
        args: ["-c", "from importlib.metadata import version; print(version('deepagents'))"],
        cwd: root,
        env: containerEnv,
        inheritEnv: false,
        input: null,
      },
      context.signal,
    )
  ).trim();
  if (probed !== DEEPAGENTS_VERSION) {
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      `the installed deepagents version ${JSON.stringify(probed)} does not match the pinned ${DEEPAGENTS_VERSION}`,
    );
  }
  // openai/truststore verifies against the system CA store, which slim task
  // images often lack (no ca-certificates); the venv's certifi bundle is the
  // same trust anchor the httpx stack uses, so export it when present.
  const certifi = (
    await cliOutput(
      start,
      {
        executable: python,
        args: ["-c", "import certifi; print(certifi.where())"],
        cwd: root,
        env: containerEnv,
        inheritEnv: false,
        input: null,
      },
      context.signal,
    ).catch(() => undefined)
  )?.trim();
  context.signal.throwIfAborted();
  // profile/installationId mirror the SDK registry record (manifest.name +
  // short digest); the baked install never runs the CLI installer, so the
  // identity comes from the verified candidate and the image runtime.
  const manifest = parseYaml(await readFile(join(preparation.path, "bundle.yaml"), "utf8")) as { name?: unknown };
  const profile = typeof manifest.name === "string" ? manifest.name : "";
  if (profile === "")
    throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "deepagents bundle.yaml must declare a string name");
  const identity = createHash("sha256")
    .update(canonicalJson({ kind: "deepagents-docker", candidate, runtime: runtime.identity }))
    .digest("hex");
  await mkdir(context.paths.agent, { recursive: true });
  await writeFile(
    join(context.paths.agent, "installation.json"),
    JSON.stringify({
      digest: candidate.digest,
      harness: verified.harness,
      home,
      profile,
      reused: true,
      installationId: `${profile}-${candidate.digest.slice("sha256:".length, "sha256:".length + 8)}`,
      runtimeIdentity: runtime.identity,
      preparationIdentity: identity,
    }),
    { mode: 0o600 },
  );
  // Model binding is per-attempt environment, not image content. Isolated
  // environments expose the model API at a mapped loopback endpoint; the
  // original configured endpoint stays authoritative in run records.
  const binding = deepagentsModelBinding(preparation.model);
  const selection = { ...binding.selection };
  const mapping = session.modelEndpoint;
  if (mapping && preparation.model.endpoint === mapping.originEndpoint) selection.OPENAI_BASE_URL = mapping.baseUrl;
  return preparedAttempt(
    async () => {},
    (input, signal) =>
      start(
        {
          executable: python,
          args: [runner, "--bundle-dir", bundle, "--json"],
          cwd: session.workdir,
          env: {
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            LANG: "C.UTF-8",
            HOME: "/tmp",
            ...(certifi === undefined || certifi === "" ? {} : { SSL_CERT_FILE: certifi }),
            ...selection,
            ...(binding.secretEnvName === null ? {} : { [binding.secretEnvName]: preparation.auth.value }),
          },
          inheritEnv: false,
          input: Buffer.from(input.prompt),
        },
        signal,
      ),
    (handle, solveContext, signal) =>
      consumeDsh(handle, { ...solveContext, signal }, preparation.auth.value, undefined, "DEEPAGENTS"),
  );
}

export async function prepareDeepagentsLocal(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  assertOptions(preparation.options);
  const runtime = session.runtime!;
  // venv creation, editable installs and the POSIX venv layout are only
  // provided for managed local runtimes in this release.
  if (!runtime.persistent)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "deepagents bundles require the local environment in this release",
    );
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const node = process.execPath;
  // Model binding is per-attempt environment, not home content: different
  // model configurations safely share one installation home.
  const binding = deepagentsModelBinding(preparation.model);
  const identity = createHash("sha256")
    .update(canonicalJson({ kind: "deepagents", candidate, runtime: runtime.identity }))
    .digest("hex");
  let state = join(stateRoot, identity.slice(0, 24));
  const cli = join(runtime.root, "agentbundle", "run.mjs");
  const runner = join(runtime.root, "deepagents", "runner.py");
  const constraints = join(runtime.root, "deepagents", "constraints.txt");
  const env = {
    ...runtimeProcessEnvironment(),
    HOME: state,
    USERPROFILE: state,
    AGENT_BUNDLE_REGISTRY: join(state, "registry.json"),
    // Deterministic installs: pip/uv must resolve the pinned harness version
    // recorded by the post-install probe, never a drifting range resolution.
    UV_CONSTRAINT: constraints,
    PIP_CONSTRAINT: constraints,
    // Managed interpreters and package caches are shared across bundle homes
    // inside the managed state root instead of re-downloaded per identity.
    UV_PYTHON_INSTALL_DIR: join(stateRoot, ".uv-python"),
    UV_CACHE_DIR: join(stateRoot, ".uv-cache"),
    ...(process.env.UV_BIN === undefined ? {} : { UV_BIN: process.env.UV_BIN }),
    ...(process.env.PYTHON_BIN === undefined ? {} : { PYTHON_BIN: process.env.PYTHON_BIN }),
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", DEEPAGENTS_VERSION],
    cwd: runtime.root,
    env: preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env,
    inheritEnv: false,
    input: null,
  });
  const release = await acquireRuntimeLock(join(stateRoot, `${identity}.lock`), context.signal);
  try {
    // uv venv refuses to create a venv into an existing directory, so the
    // identity marker is claimed only once the CLI materialized the home;
    // the cross-process lock covers concurrent first installs.
    const exists = await lstat(state).then(
      () => true,
      error => {
        if (hasCode(error, "ENOENT")) return false;
        throw error;
      },
    );
    if (exists) {
      state = await claimPersistentState(stateRoot, state, identity);
      if (
        !(await lstat(join(state, "bin", "python")).then(
          () => true,
          error => {
            if (hasCode(error, "ENOENT")) return false;
            throw error;
          },
        ))
      ) {
        // A claimed home without its interpreter is an incomplete install
        // (e.g. a crash before the venv finished); under the lock it owns no
        // running sessions, so recover by discarding and reinstalling.
        await rm(state, { recursive: true, force: true });
        state = join(stateRoot, identity.slice(0, 24));
      }
    }
    env.HOME = state;
    env.USERPROFILE = state;
    env.AGENT_BUNDLE_REGISTRY = join(state, "registry.json");
    const bundle = preparation.path;
    const verified = parseVerifiedBundle(
      await cliJson(start, command(["verify", bundle, "--expect-digest", candidate.digest]), context.signal),
    );
    sameCandidate(candidate, verified);
    const installed = parseInstalledBundle(
      await cliJson(start, command(["install", bundle, "--home", state]), context.signal),
    );
    sameCandidate(candidate, installed);
    if (installed.home !== state)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI installed outside the requested home");
    state = await claimPersistentState(stateRoot, state, identity);
    env.HOME = state;
    env.USERPROFILE = state;
    env.AGENT_BUNDLE_REGISTRY = join(state, "registry.json");
    const python = join(state, "bin", "python");
    const probed = (
      await cliOutput(
        start,
        {
          executable: python,
          args: ["-c", "from importlib.metadata import version; print(version('deepagents'))"],
          cwd: runtime.root,
          env,
          inheritEnv: false,
          input: null,
        },
        context.signal,
      )
    ).trim();
    if (probed !== DEEPAGENTS_VERSION) {
      throw new AgentBundleError(
        "SOURCE_CHANGED",
        `the installed deepagents version ${JSON.stringify(probed)} does not match the pinned ${DEEPAGENTS_VERSION}`,
      );
    }
    context.signal.throwIfAborted();
    await mkdir(context.paths.agent, { recursive: true });
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
            executable: python,
            args: [runner, "--bundle-dir", bundle, "--json"],
            cwd: session.workdir,
            env: {
              ...env,
              ...binding.selection,
              ...(binding.secretEnvName === null ? {} : { [binding.secretEnvName]: preparation.auth.value }),
            },
            inheritEnv: false,
            input: Buffer.from(input.prompt),
          },
          signal,
        ),
      (handle, solveContext, signal) =>
        consumeDsh(handle, { ...solveContext, signal }, preparation.auth.value, undefined, "DEEPAGENTS"),
    );
  } catch (error) {
    await release();
    throw error;
  }
}
