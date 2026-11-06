import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, cliOutput, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";

import { JIUWENSWARM_DOCKER_BUNDLE_TARGET, JIUWENSWARM_DOCKER_HOME_TARGET, JIUWENSWARM_PROCESS_CLI_MARKER, JIUWENSWARM_PROCESS_CLI_NAME, JIUWENSWARM_TIMEOUT_SECONDS, JIUWENSWARM_VERSION, jiuwenswarmProcessCliProbe, resolveJiuwenswarmCommand } from "./runtime.js";
import { consumeJiuwenswarm } from "./protocol.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";

import { type BundlePreparation, sameCandidate, customHomeDirectory, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";
/**
 * Bounded model client timeouts for the jiuwenswarm solver. The env fallback in
 * jiuwenswarm/common/config.py `get_default_models` hardcodes a 1800s transport
 * timeout with no stream-timeout channel, so a stalled upstream holds the LLM
 * call (and its retry rail) far beyond the jiuwenswarm-process budget.
 * `models.defaults` is the only config channel that can bound it: the entries
 * win over the env fallback, and ${ENV} placeholders resolve at read time via
 * the runtime's resolve_env_vars, keeping credentials caller-side.
 */
const JIUWENSWARM_MODEL_CLIENT_TIMEOUTS = `
models:
  defaults:
    - model_client_config:
        api_base: \${API_BASE}
        api_key: \${API_KEY}
        model_name: \${MODEL_NAME}
        client_provider: \${MODEL_PROVIDER}
        endpoint_profile: \${ENDPOINT_PROFILE}
        timeout: 300
        verify_ssl: false
        stream_first_chunk_timeout: 180
        stream_idle_timeout: 120
      model_config_obj: {}
`.trim();

/** Merge bounded model client timeouts into the install-written jiuwenswarm
 *  config.yaml without clobbering the bundle sections or bootstrap additions. */
function mergeJiuwenswarmModelConfig(existing: string): string {
  let doc: Record<string, unknown> = {};
  if (existing.trim() !== "") {
    const parsed = parseYaml(existing);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  }
  const additions = parseYaml(JIUWENSWARM_MODEL_CLIENT_TIMEOUTS) as Record<string, unknown>;
  const models = (doc.models ?? {}) as Record<string, unknown>;
  const additionsModels = (additions.models ?? {}) as Record<string, unknown>;
  const fallback = (additionsModels.defaults as Record<string, unknown>[])[0]!;
  const clientDefaults = fallback.model_client_config as Record<string, unknown>;
  const defaults = models.defaults;
  if (defaults !== undefined && !Array.isArray(defaults))
    throw new AgentBundleError("CONFIG_INVALID", "jiuwenswarm models.defaults must be an array");
  const entries = Array.isArray(defaults) && defaults.length ? defaults : [fallback];
  const merged = entries.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new AgentBundleError("CONFIG_INVALID", "jiuwenswarm model entry must be a mapping");
    const model = entry as Record<string, unknown>;
    // Bound transport waits without replacing the installed model request
    // configuration (output limits, reasoning effort and other bundle settings).
    return { ...model, model_client_config: {
      ...clientDefaults,
      ...(model.model_client_config as Record<string, unknown> | undefined),
      timeout: clientDefaults.timeout,
      stream_first_chunk_timeout: clientDefaults.stream_first_chunk_timeout,
      stream_idle_timeout: clientDefaults.stream_idle_timeout,
    }, model_config_obj: model.model_config_obj ?? {} };
  });
  return stringifyYaml({ ...doc, models: { ...models, defaults: merged } });
}

export async function prepareJiuwenswarm(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  const runtime = session.runtime!;
  // jiuwenswarm-process is a host binary run against an isolated data
  // directory, so this release supports the managed local runtime only.
  if (!runtime.persistent)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "jiuwenswarm bundles require the local environment in this release",
    );
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const node = process.execPath;
  const version = preparation.harnessVersion ?? JIUWENSWARM_VERSION;
  // Model binding is per-attempt environment, not home content: different
  // model configurations safely share one installation home.
  const identity = createHash("sha256")
    .update(canonicalJson({ kind: "jiuwenswarm", candidate, runtime: runtime.identity }))
    .digest("hex");
  const configuredHome = preparation.options.jiuwenswarmhome;
  const customHome = configuredHome !== undefined;
  let state =
    configuredHome !== undefined ? await customHomeDirectory(configuredHome) : join(stateRoot, identity.slice(0, 24));
  const cli = join(runtime.root, "agentbundle", "run.mjs");
  const env = {
    ...runtimeProcessEnvironment(),
    HOME: state,
    USERPROFILE: state,
    AGENT_BUNDLE_REGISTRY: join(state, "registry.json"),
    // The bundle's agent.yaml binds ${AGENT_MODEL_PROVIDER}/${AGENT_MODEL_NAME}
    // into <home>/config/.env at install time; credentials stay caller-side.
    AGENT_MODEL_PROVIDER: "OpenAI",
    AGENT_MODEL_NAME: preparation.model.name,
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", version],
    cwd: runtime.root,
    env: preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env,
    inheritEnv: false,
    input: null,
  });
  const release = await acquireRuntimeLock(
    customHome ? join(state, ".evaluator.lock") : join(stateRoot, `${identity}.lock`),
    context.signal,
  );
  try {
    state = await claimPersistentState(customHome ? dirname(state) : stateRoot, state, identity);
    env.HOME = state;
    env.USERPROFILE = state;
    env.AGENT_BUNDLE_REGISTRY = join(state, "registry.json");
    const verified = parseVerifiedBundle(
      await cliJson(start, command(["verify", preparation.path, "--expect-digest", candidate.digest]), context.signal),
    );
    sameCandidate(candidate, verified);
    const installed = parseInstalledBundle(
      await cliJson(start, command(["install", preparation.path, "--home", state]), context.signal),
    );
    sameCandidate(candidate, installed);
    if (installed.home !== state)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI installed outside the requested home");
    context.signal.throwIfAborted();
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(
      join(context.paths.agent, "installation.json"),
      JSON.stringify({ ...installed, runtimeIdentity: runtime.identity, preparationIdentity: identity }),
      { mode: 0o600 },
    );
    const jiuwenswarm = await resolveJiuwenswarmCommand(process.env);
    if (jiuwenswarm === undefined) {
      throw new AgentBundleError(
        "ENV_RUNTIME_INSTALL_FAILED",
        "cannot resolve jiuwenswarm-process; set JIUWENSWARM_BIN or JIUWENSWARM_CHECKOUT to the pinned runtime",
      );
    }
    const endpoint = preparation.model.endpoint;
    if (endpoint === null)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "jiuwenswarm solver requires a model endpoint");
    return preparedAttempt(
      release,
      (input, signal) =>
        start(
          {
            executable: jiuwenswarm.command,
            args: [
              input.prompt,
              "--output",
              "json",
              "--cwd",
              session.workdir,
              "--timeout",
              String(preparation.options.jiuwenswarmTimeoutSeconds ?? JIUWENSWARM_TIMEOUT_SECONDS),
            ],
            cwd: session.workdir,
            env: {
              ...env,
              // jiuwenswarm writes the JSON envelope on stdout; the Windows
              // console default (cp936) cannot encode model output such as
              // U+2212 and aborts the run before any envelope is written.
              PYTHONIOENCODING: "utf-8",
              JIUWENSWARM_DATA_DIR: state,
              API_BASE: endpoint,
              API_KEY: preparation.auth.value,
              MODEL_NAME: preparation.model.name,
              MODEL_PROVIDER: "OpenAI",
              ENDPOINT_PROFILE: "openai",
            },
            inheritEnv: false,
            input: null,
          },
          signal,
        ),
      (handle, solveContext, signal) => consumeJiuwenswarm(handle, { ...solveContext, signal }, preparation.auth.value),
    );
  } catch (error) {
    await release();
    throw error;
  }
}

  /**
   * Docker jiuwenswarm preparation: the harness venv was baked into the solver
   * image at build time, so prepare only cross-checks the baked content against
   * the locked candidate, installs the bundle into the container's state root
   * and records the installation evidence. The image is immutable and the
   * container is single-attempt, so no runtime lock is needed.
   */

export async function prepareJiuwenswarmDocker(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  if (preparation.options.dshhome !== undefined || preparation.options.dshprofile !== undefined) {
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "dshhome and dshprofile configure the DSH harness and are not accepted for jiuwenswarm bundles",
    );
  }
  const runtime = session.runtime!;
  if (runtime.persistent)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "jiuwenswarm docker preparation requires the docker environment");
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const root = runtime.root;
  const bundle = posix.join(root, JIUWENSWARM_DOCKER_BUNDLE_TARGET);
  const home = posix.join(root, JIUWENSWARM_DOCKER_HOME_TARGET);
  const process = posix.join(home, "bin", JIUWENSWARM_PROCESS_CLI_NAME);
  const cli = posix.join(root, "agentbundle", "run.mjs");
  const version = preparation.harnessVersion ?? JIUWENSWARM_VERSION;
  // The container is disposable, so the bundle home derives from the attempt
  // identity instead of a shared host cache; model binding stays per-attempt
  // environment exactly as in local mode.
  const identity = createHash("sha256")
    .update(canonicalJson({ kind: "jiuwenswarm-docker", candidate, runtime: runtime.identity }))
    .digest("hex");
  const state = posix.join(stateRoot, identity.slice(0, 24));
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: state,
    USERPROFILE: state,
    AGENT_BUNDLE_REGISTRY: posix.join(state, "registry.json"),
    // The bundle's agent.yaml binds ${AGENT_MODEL_PROVIDER}/${AGENT_MODEL_NAME}
    // into <home>/config/.env at install time; credentials stay caller-side.
    AGENT_MODEL_PROVIDER: "OpenAI",
    AGENT_MODEL_NAME: preparation.model.name,
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: "node",
    args: [cli, "--json", ...args, "--harness-version", version],
    cwd: root,
    env: preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env,
    inheritEnv: false,
    input: null,
  });
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
  // Pull back the install-written config.yaml (bundle sections plus the
  // agent-bundle bootstrap additions), merge bounded model client timeouts
  // under models.defaults, and re-upload: the env fallback in
  // get_default_models hardcodes a 1800s transport timeout, so a stalled
  // upstream holds the LLM call and its retry rail beyond the process budget.
  const configTarget = posix.join(state, "config", "config.yaml");
  const installedConfig = String(
    (
      await cliOutput(
        start,
        {
          executable: "cat",
          args: [configTarget],
          cwd: root,
          env,
          inheritEnv: false,
          input: null,
        },
        context.signal,
      )
    ).trim(),
  );
  const mergedConfig = mergeJiuwenswarmModelConfig(installedConfig);
  const configYaml = join(context.paths.agent, "jiuwenswarm-config.yaml");
  await mkdir(context.paths.agent, { recursive: true });
  await writeFile(configYaml, mergedConfig, { mode: 0o600 });
  await session.upload(configYaml, configTarget, context.signal);
  const probed = (
    await cliOutput(
      start,
      {
        ...jiuwenswarmProcessCliProbe(posix.join(home, "bin", "python")),
        cwd: root,
        env,
        inheritEnv: false,
        input: null,
      },
      context.signal,
    )
  ).trim();
  // SDK imports can emit initialization logs before our final success marker.
  if (probed.split(/\r?\n/u).at(-1) !== JIUWENSWARM_PROCESS_CLI_MARKER) {
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      `the solver image does not carry the headless ${JIUWENSWARM_PROCESS_CLI_NAME} CLI (probe returned ${JSON.stringify(probed)})`,
    );
  }
  context.signal.throwIfAborted();
  await mkdir(context.paths.agent, { recursive: true });
  await writeFile(
    join(context.paths.agent, "installation.json"),
    JSON.stringify({
      ...installed,
      reused: true,
      harnessVersion: version,
      runtimeIdentity: runtime.identity,
      preparationIdentity: identity,
    }),
    { mode: 0o600 },
  );
  const endpoint = preparation.model.endpoint;
  if (endpoint === null)
    throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "jiuwenswarm solver requires a model endpoint");
  // Isolated environments expose the model API at a mapped loopback endpoint;
  // the original configured endpoint stays authoritative in run records.
  const mapping = session.modelEndpoint;
  const apiBase = mapping && preparation.model.endpoint === mapping.originEndpoint ? mapping.baseUrl : endpoint;
  return preparedAttempt(
    async () => {},
    (input, signal) =>
      start(
        {
          executable: process,
          args: [
            input.prompt,
            "--output",
            "json",
            "--cwd",
            session.workdir,
            "--timeout",
            String(preparation.options.jiuwenswarmTimeoutSeconds ?? JIUWENSWARM_TIMEOUT_SECONDS),
          ],
          cwd: session.workdir,
          env: {
            ...env,
            JIUWENSWARM_DATA_DIR: state,
            API_BASE: apiBase,
            API_KEY: preparation.auth.value,
            MODEL_NAME: preparation.model.name,
            MODEL_PROVIDER: "OpenAI",
            ENDPOINT_PROFILE: "openai",
          },
          inheritEnv: false,
          input: null,
        },
        signal,
      ),
    (handle, solveContext, signal) => consumeJiuwenswarm(handle, { ...solveContext, signal }, preparation.auth.value),
  );
}
