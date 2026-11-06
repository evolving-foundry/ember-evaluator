import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { createBundleSdk, defaultRegistryPath, loadRegistry, resolveDifyConsole } from "agent-bundle-core";
import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { formatError, redactDiagnostic } from "../../core/errors/diagnostics.js";
import { classifyError } from "../../core/errors/classify.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";
import { AgentBundleError, type VerifiedBundle } from "../agentbundle/cli.js";
import { preparedAttempt, sameCandidate } from "../agentbundle/preparation-state.js";
import { verifyBundleCandidate } from "../agentbundle/sdk.js";
import type { DifyOptions } from "./config.js";
import { consumeDify } from "./protocol.js";

export async function prepareDify(
  bundlePath: string,
  options: DifyOptions,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  const runtime = session.runtime;
  if (!runtime?.root || !runtime.identity) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Dify requires an environment-prepared runtime");
  const service = createHash("sha256").update(options.baseUrl).digest("hex").slice(0, 24);
  const registryPath = options.registryPath ?? join(dirname(defaultRegistryPath()), "dify", service, "installations.json");
  const signal = context.signal;
  const release = await acquireRuntimeLock(`${registryPath}.evaluator.lock`, signal);
  try {
    // Recheck even when the SDK can reuse an installation: the source is locked for this run.
    sameCandidate(candidate, await verifyBundleCandidate(bundlePath));
    signal.throwIfAborted();
    const records = await loadRegistry(registryPath);
    if (records.some(record => record.kind === "dify-agent-bundle" && record.digest === candidate.digest &&
        record.baseUrl?.replace(/\/+$/, "") !== options.baseUrl)) {
      throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Dify installation belongs to a different service; select another agentbundle.dify.registryPath");
    }
    const env = { ...process.env, DIFY_BASE: options.baseUrl };
    const reused = records.some(record => record.kind === "dify-agent-bundle" && record.digest === candidate.digest && record.appId !== undefined);
    const credentials = reused ? undefined : await resolveDifyConsole(env, false);
    const secrets = [credentials?.adminApiKey, credentials?.password].filter((value): value is string => !!value);
    const sdk = createBundleSdk({ env, registryPath, fetchFn: async (url, init) => {
      signal.throwIfAborted();
      // Console writes are not repeatable: pass cancellation, but never retry an import or publish.
      const response = await fetch(url, { ...init, signal });
      return { status: response.status, text: await response.text(), setCookie: response.headers.getSetCookie() };
    } });
    const installed = await sdk.install(bundlePath, { mode: "persistent" }).catch((error: unknown) => {
      signal.throwIfAborted();
      const failure = classifyError(error, { phase: "install", secrets });
      // The outer boundary does not know dynamically resolved Console credentials.
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", `Dify install: ${redactDiagnostic(failure.message, secrets)}`, failure.details,
        { cause: new Error(formatError(error, secrets)) });
    });
    // SDK registry records contain the Service API key; do not copy them into run artifacts.
    await chmod(registryPath, 0o600);
    sameCandidate(candidate, { digest: installed.digest, harness: installed.harness });
    sameCandidate(candidate, await verifyBundleCandidate(bundlePath));
    if (!installed.apiKey) throw new AgentBundleError("MODEL_AUTH_FAILED", "Dify installation carries no Service API key");
    if (!installed.appId) throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "Dify installation carries no appId");
    signal.throwIfAborted();
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(join(context.paths.agent, "installation.json"), JSON.stringify({
      ...candidate,
      installationId: installed.installationId, appId: installed.appId, reused: installed.reused,
      runtimeIdentity: runtime.identity,
    }), { mode: 0o600 });
    const apiKey = installed.apiKey;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    return preparedAttempt(async () => {}, (input, solveSignal) => session.start({
      executable: local ? process.execPath : "node",
      args: [path(runtime.root, "dify", "runner.mjs")],
      cwd: session.workdir,
      env: local ? runtimeProcessEnvironment() : {},
      inheritEnv: false,
      input: Buffer.from(`${JSON.stringify({
        schemaVersion: 1, baseUrl: options.baseUrl, apiKey, task: input.prompt,
        appId: installed.appId, attempt: context.key, outputDir: session.agentOutputDir,
        bundleDigest: installed.digest, installationId: installed.installationId, reused: installed.reused,
      })}\n`, "utf8"),
    }, solveSignal), (handle, solveContext, solveSignal) => consumeDify(handle, solveContext, solveSignal, apiKey));
  } finally {
    await release();
  }
}
