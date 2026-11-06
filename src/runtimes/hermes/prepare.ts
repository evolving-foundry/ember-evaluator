import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, posix } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelConfig } from "../../core/contracts/config.js";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";

import { HERMES_VERSION, hermesRuntimeInstallation } from "./runtime.js";
import { HERMES_AUTH_ENV, hermesModelSettings } from "./model.js";
import { consumeHermes } from "./protocol.js";

import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";

import { type BundlePreparation, sameCandidate, hasCode, customHomeDirectory, writeHomeConfig, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";
/** Merge the solver's model_aliases into the install-written Hermes config.yaml
 *  without clobbering model.default/model.provider owned by the bundle install. */
async function mergeHermesModelConfig(target: string, model: ModelConfig, signal: AbortSignal): Promise<string> {
  let existing = "";
  try {
    existing = await readFile(target, { encoding: "utf8", signal });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  let doc: Record<string, unknown> = {};
  if (existing.trim() !== "") {
    const parsed = parseYaml(existing);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  }
  const additions = parseYaml(hermesModelSettings(model)) as Record<string, unknown>;
  return stringifyYaml({ ...doc, ...additions });
}

export async function prepareHermes(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  const runtime = session.runtime!;
  // Hermes is provisioned into the runtime root at build time (see
  // hermesRuntimeInstallation), so it runs under any environment, not just
  // the managed local runtime.
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const local = runtime.persistent;
  const path = local ? join : posix.join;
  const node = local ? process.execPath : "node";
  const version = preparation.harnessVersion ?? HERMES_VERSION;
  const identity = createHash("sha256")
    .update(
      canonicalJson({ kind: "hermes", candidate, runtime: runtime.identity, settings: hermesModelSettings(preparation.model) }),
    )
    .digest("hex");
  const configuredHome = local ? preparation.options.hermeshome : undefined;
  const customHome = configuredHome !== undefined;
  let state =
    configuredHome !== undefined ? await customHomeDirectory(configuredHome) : join(stateRoot, identity.slice(0, 24));
  const cli = join(runtime.root, "agentbundle", "run.mjs");
  // R10: the pm-runtime (ruamel-bearing deps) is provisioned under the runtime-root HOME (see
  // hermesRuntimeInstallation provisionEnv HOME={root}). agent-bundle install borrows it via
  // nativeHome(env.HERMES_HOME)/installs, so run.mjs's env points at the provision home while the
  // --home route keeps the plugin registry + config isolated (borrow links <state>/installs -> <provision>/installs).
  const provisionHome = path(runtime.root, ".hermes");
  const systemEnv = local
    ? runtimeProcessEnvironment()
    : { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  const hostPath = Object.entries(systemEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env = {
    ...systemEnv,
    // agent-bundle install enables plugins by spawning `hermes` from PATH, so the
    // provisioned launcher dir (materialized by setup-hermes.sh --runtime-only into
    // hermes-agent/.hermes/bin — v0.21.6 has no venv/bin/hermes) must precede it.
    PATH: `${path(runtime.root, "hermes-agent", ".hermes", "bin")}${local ? delimiter : ":"}${hostPath}`,
    // v0.21.6 plugin deps are installed by `hermes plugins enable` via PM `uv sync --frozen` against
    // the checkout's uv.lock (URLs pinned to files.pythonhosted.org). PIP_INDEX_URL is a no-op for
    // that path (R8): mirroring needs a uv.lock re-lock at provision time (see runtime.ts R8 note).
    HOME: state,
    USERPROFILE: state,
    HERMES_HOME: state,
    AGENT_BUNDLE_REGISTRY: join(state, "registry.json"),
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", version],
    cwd: runtime.root,
    env: { ...(preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env), HERMES_HOME: provisionHome },
    inheritEnv: false,
    input: null,
  });
  const release = local
    ? await acquireRuntimeLock(
        customHome ? join(state, ".evaluator.lock") : join(stateRoot, `${identity}.lock`),
        context.signal,
      )
    : async () => {};
  try {
    if (local) state = await claimPersistentState(customHome ? dirname(state) : stateRoot, state, identity);
    env.HOME = state;
    env.USERPROFILE = state;
    env.HERMES_HOME = state;
    env.AGENT_BUNDLE_REGISTRY = join(state, "registry.json");
    const bundle = local ? preparation.path : join(state, "bundle");
    if (!local) await session.upload(preparation.path, bundle, context.signal);
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
    context.signal.throwIfAborted();
    // Merge the solver's model_aliases into the install-written config.yaml
    // without clobbering model.default/model.provider owned by the preparation.
    const merged = await mergeHermesModelConfig(join(state, "config.yaml"), preparation.model, context.signal);
    const configYaml = join(context.paths.agent, "hermes-config.yaml");
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(configYaml, merged, { mode: 0o600 });
    if (customHome) {
      await writeHomeConfig(join(state, "config.yaml"), merged);
    } else {
      await session.upload(configYaml, join(state, "config.yaml"), context.signal);
    }
    context.signal.throwIfAborted();
    await writeFile(
      join(context.paths.agent, "installation.json"),
      JSON.stringify({ ...installed, runtimeIdentity: runtime.identity, preparationIdentity: identity }),
      { mode: 0o600 },
    );
    const usageFile = join(context.paths.agent, "usage.json");
    return preparedAttempt(
      release,
      (input, signal) =>
        start(
          {
            executable: "bash",
            args: [path(runtime.root, "hermes-agent", "scripts", "run-in-hermes-env"), "python",
              path(runtime.root, "hermes", "runner.py"), path(runtime.root, "hermes-agent"),
              "-z", input.prompt, "--usage-file", usageFile, "--in", session.workdir, "-m", preparation.model.name],
            cwd: session.workdir,
            env: {
              ...env,
              HERMES_HOME: state,
              OFFICE_AGENT_WORKDIR: join(state, "work", "office-agent"),
              [HERMES_AUTH_ENV]: preparation.auth.value,
            },
            inheritEnv: false,
            input: null,
          },
          signal,
        ),
      (handle, solveContext, signal, input) =>
        consumeHermes(handle, { ...solveContext, signal }, preparation.auth.value, usageFile, undefined, {
          prompt: input.prompt,
          model: preparation.model.name,
        }),
    );
  } catch (error) {
    await release();
    throw error;
  }
}
