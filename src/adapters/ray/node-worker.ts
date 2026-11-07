import { restoreNetworkTemplate, validateNetworkSnapshot } from "../../config/network.js";
import { parseRuntimeServices } from "./runtime-services.js";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { bootstrap } from "../../bootstrap.js";
import { openPluginRegistry, type PluginRegistry } from "../../plugin-runtime.js";
import { expectRecord, DEFAULT_METRICS, type LoadedConfig } from "../../config/schema.js";
import { PACKAGE_RUNTIME_ID, loadPackageDigest } from "../../core/package-provenance.js";
import { fingerprintConfig } from "../../core/run-manifest.js";
import { assertSolverProvenance, resolveSolverProvenance } from "../../core/solver-provenance.js";
import { runTask } from "../../core/run-task.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import type { FileManifest, RunManifest, TaskPreparationTiming } from "../../core/contracts/result.js";
import type { PreparedTask, JsonValue } from "../../core/contracts/task.js";
import { safeTaskKey } from "../../core/artifacts.js";
import { TransferClient } from "../transfer/client.js";
import { validateUploadManifest } from "../transfer/protocol.js";
import { assertWorkerVersions, localizePortableSelection, validateRemoteJob } from "./protocol.js";
import { parseNodeConfig, type NodeConfig } from "./node-config.js";
import { ProgressPublisher } from "../../core/progress-wire.js";
import { progressOperation } from "../../core/progress-operation.js";
import { assertEnvironmentTimeouts } from "../../core/preparation-validation.js";
import { createTaskPreparer } from "../../core/materialize-task.js";

export async function executeRemoteNode(input: unknown, node: NodeConfig, token: string, sharedRegistry?: PluginRegistry): Promise<unknown> {
  const registry = sharedRegistry ?? await openPluginRegistry(node.pluginPatchPath);
  try { return await executeRegisteredNode(input, node, token, registry); }
  finally { if (!sharedRegistry) await registry.dispose(); }
}

async function executeRegisteredNode(input: unknown, node: NodeConfig, token: string, registry: PluginRegistry): Promise<unknown> {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Ray node requires Node 24");
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "hostname,nodeId,remote"
  )
    throw new TypeError("Invalid Ray worker envelope");
  const envelope = input as { remote: unknown; nodeId: unknown; hostname: unknown };
  for (const label of [envelope.nodeId, envelope.hostname])
    if (typeof label !== "string" || !label || label.length > 4096 || /[\u0000-\u001f]/u.test(label))
      throw new TypeError("Invalid Ray node identity");
  const nodeId = envelope.nodeId as string,
    hostname = envelope.hostname as string;
  await registry.loadRecordedPlugins(expectRecord(envelope.remote, "remote job").pluginVersions);
  const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
  const remote = validateRemoteJob(envelope.remote, lookup);
  if (remote.preparation && remote.preparation.nodeId !== nodeId)
    throw new Error("Ray worker differs from prepared node placement");
  const key = { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId };
  const packageDigest = await loadPackageDigest();
  const versions = registry.pluginVersions;
  assertWorkerVersions(remote.pluginVersions, versions, remote.packageDigest, packageDigest);
  const client = new TransferClient({
    endpoint: remote.uploadEndpoint,
    token,
    ca: await readFile(node.caFile),
    timeoutMs: 5000,
    retries: 1,
  });
  const bindings = parseRuntimeServices(await client.control(
    "runtime",
    { key, nodeId, hostname, packageDigest, pluginVersions: versions },
    AbortSignal.timeout(30_000),
  ), { preparation: remote.preparation?.mode === "prepare" });
  const secrets = [...Object.values(bindings).map(binding => binding.auth.value), token];
  const progress = new ProgressPublisher((snapshot, signal) => client.control("progress", { key, nodeId, snapshot }, signal), secrets);
  const cancellation = new AbortController();
  if (remote.preparation?.mode === "prepare" && remote.preparation.deadlineAt !== null) {
    const remaining = Date.parse(remote.preparation.deadlineAt) - Date.now();
    if (remaining <= 0 || remaining > 2_147_483_647) throw new Error("Batch preparation deadline exceeded");
    const deadline = AbortSignal.timeout(Math.ceil(remaining));
    deadline.addEventListener("abort", () => cancellation.abort(deadline.reason), { once: true });
  }
  const heartbeatStop = new AbortController();
  let uploading = false;
  const heartbeat = (async () => {
    let failures = 0;
    while (!heartbeatStop.signal.aborted) {
      try {
        const response = (await client.control(
          "control",
          { key, nodeId, state: uploading ? "uploading" : "running" },
          heartbeatStop.signal,
        )) as { cancelled?: unknown; reason?: unknown };
        if (typeof response.cancelled !== "boolean") throw new Error("Invalid Ray control response");
        if (response.cancelled) cancellation.abort(response.reason === "infrastructure-timeout"
          ? Object.assign(new Error("Ray coordinator detected infrastructure timeout"), { code: "RAY_HEARTBEAT_TIMEOUT" })
          : new Error("Coordinator cancelled Ray task"));
        failures = 0;
      } catch {
        if (++failures >= 3) cancellation.abort(Object.assign(new Error("Ray coordinator heartbeat unavailable"), { code: "RAY_HEARTBEAT_TIMEOUT" }));
      }
      try {
        await delay(1000, undefined, { signal: heartbeatStop.signal });
      } catch {
        break;
      }
    }
  })();
  const root = join(node.outputRoot, "jobs", key.attemptId);
  let components: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let preparationTiming: TaskPreparationTiming | undefined;
  const warnings = new Set<string>();
  try {
    const benchmark = localizePortableSelection(remote.safeConfig.benchmark, "benchmark", node, lookup);
    const environment = localizePortableSelection(remote.safeConfig.environment, "environment", node, lookup);
    const service = remote.safeConfig.solver.service;
    const config: LoadedConfig = {
      ...(remote.safeConfig.network ? { network: restoreNetworkTemplate(remote.safeConfig.network.template, process.env), benchmarkName: remote.safeConfig.network.benchmarkName } : {}),
      experiment: {
        hardware: remote.safeConfig.hardware ?? "npu",
        services: Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.model])),
        benchmark,
        environment,
        solver: localizePortableSelection(remote.safeConfig.solver, "solver", node, lookup),
        ...(remote.safeConfig.verifier ? { verifier: localizePortableSelection(remote.safeConfig.verifier, "verifier", node, lookup) } : {}),
        metrics: [...DEFAULT_METRICS],
        reporter: { name: "markdown", config: {} },
        store: { name: "local", config: {} },
        scheduler: { name: "local", config: { concurrency: 1 } },
        run: {
          taskIds: [key.taskId],
          maxTasks: null,
          timeoutSeconds: remote.safeConfig.timeoutSeconds,
          ...(remote.safeConfig.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: remote.safeConfig.solveTimeoutSeconds }),
          ...(remote.safeConfig.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: remote.safeConfig.verifyTimeoutSeconds }),
        },
        output: { directory: root },
      },
      auths: Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.auth])),
      persisted: remote.safeConfig as unknown as JsonValue,
    };
    components = await bootstrap(config, node.configDirectory, node.pluginPatchPath, message => {
      if (warnings.size < 8) warnings.add(redactDiagnostic(message, secrets)
        .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 4096));
    }, registry, remote.imageConfigFingerprint);
    const solverProvenance = await resolveSolverProvenance(components.solver, cancellation.signal, [
      ...secrets,
      token,
    ], remote.solverProvenance);
    assertSolverProvenance(remote.solverProvenance, solverProvenance);
    assertWorkerVersions(
      remote.pluginVersions,
      { ...components.pluginVersions, [PACKAGE_RUNTIME_ID]: packageDigest },
      remote.packageDigest,
      packageDigest,
    );
    const validateSource = () => progressOperation(progress.observe,
      { phase: "source", message: "Validating the node data source", taskId: key.taskId, attemptId: key.attemptId }, cancellation.signal, async activity => {
      const source = await components!.benchmark.resolveSource(remote.source, cancellation.signal, activity);
      if (fingerprintConfig(source) !== fingerprintConfig(remote.source)) throw new Error("Ray node source lock mismatch");
      let matches = 0;
      for await (const ref of components!.benchmark.enumerate(source, cancellation.signal, activity)) {
        if (ref.id !== key.taskId) continue;
        if (fingerprintConfig(ref) !== fingerprintConfig(remote.job.ref)) throw new Error("Ray node task reference mismatch");
        matches++;
      }
      if (matches !== 1) throw new Error("Ray node task not uniquely present in locked source");
      return source;
    });
    const preparationFile = remote.preparation
      ? join(node.outputRoot, "preparations", key.runId, remote.preparation.roundId, `${safeTaskKey(key.taskId)}.json`)
      : null;
    let preparedTask: PreparedTask | undefined;
    if (remote.preparation?.mode === "prepare") {
      const source = await validateSource();
      if (!components.environment.materialize) throw new Error("Node environment lacks batch materialization");
      const task = await progressOperation(progress.observe,
        { phase: "prepare", message: "Reading node task files", taskId: key.taskId, attemptId: key.attemptId }, cancellation.signal,
        activity => components!.benchmark.prepare(remote.job.ref, source, cancellation.signal, activity));
      if (task.input.id !== key.taskId || (task.transfer !== null && task.verifyEnv === null))
        throw new Error("Invalid prepared task identity or transfer");
      const timing: TaskPreparationTiming = preparationTiming = { taskId: key.taskId, status: "preparing", queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), finishedAt: null, queueDurationMs: 0, durationMs: null, phaseDurationMs: {} };
      preparedTask = await createTaskPreparer(components, { sensitiveValues: secrets, onProgress: progress.observe })(
        task, cancellation.signal, { roundId: remote.preparation.roundId, attemptId: key.attemptId, timing,
          concurrency: remote.preparation.concurrency, defaultTimeoutSeconds: remote.preparation.defaultTimeoutSeconds,
          roundSignal: cancellation.signal,
          ...(remote.preparation.environmentTimeoutSeconds === null ? {} : { environmentTimeoutSeconds: remote.preparation.environmentTimeoutSeconds }) });
      const evidence = { task: preparedTask, packageDigest, source, configFingerprint: remote.job.configFingerprint };
      const digest = fingerprintConfig(evidence);
      cancellation.signal.throwIfAborted();
      await mkdir(dirname(preparationFile!), { recursive: true });
      const temporary = `${preparationFile!}.${key.attemptId}.tmp`;
      await writeFile(temporary, JSON.stringify(evidence) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, preparationFile!);
      cancellation.signal.throwIfAborted();
      return { preparationDigest: digest, nodeId, hostname, environmentTimeouts: timing.environmentTimeouts,
        ...(warnings.size ? { warnings: [...warnings] } : {}) };
    }
    if (remote.preparation?.mode === "execute") {
      const evidence: unknown = JSON.parse(await readFile(preparationFile!, "utf8"));
      // The coordinator received this digest from the preparation worker; verify
      // the entire local receipt before trusting any private paths or image IDs.
      if (fingerprintConfig(evidence as JsonValue) !== remote.preparation.digest)
        throw new Error("Node preparation receipt differs from the ready barrier");
      const receipt = evidence as { task: PreparedTask; packageDigest: string; source: JsonValue; configFingerprint: string };
      if (receipt.packageDigest !== packageDigest || receipt.configFingerprint !== remote.job.configFingerprint ||
        fingerprintConfig(receipt.source) !== fingerprintConfig(remote.source) || receipt.task.input.id !== key.taskId)
        throw new Error("Node preparation receipt differs from dispatch");
      preparedTask = receipt.task;
    }
    const manifest: RunManifest = {
      schemaVersion: 1,
      evaluationKind: components.benchmark.evaluationKind ?? "quality",
      runId: key.runId,
      taskIds: [key.taskId],
      source: remote.source,
      configFingerprint: remote.job.configFingerprint,
      pluginVersions: remote.pluginVersions,
      ...(solverProvenance === undefined ? {} : { solverProvenance }),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      status: "running",
    };
    let existing: RunManifest | undefined;
    try {
      await readFile(join(root, key.runId, "manifest.json"));
      existing = await components.store.open(join(root, key.runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) assertSolverProvenance(existing.solverProvenance, solverProvenance);
    if (
      existing &&
      (existing.configFingerprint !== manifest.configFingerprint ||
        fingerprintConfig(existing.source) !== fingerprintConfig(remote.source) ||
        fingerprintConfig(existing.pluginVersions) !== fingerprintConfig(remote.pluginVersions))
    )
      throw new Error("Retained Ray attempt differs from locked dispatch");
    if (!existing) await components.store.create(root, manifest, config.persisted);
    const previous = (await components.store.listAttempts()).find(
      attempt => attempt.key.attemptId === key.attemptId,
    )?.record;
    if (!previous) {
      cancellation.signal.throwIfAborted();
      const source = await validateSource();
      await components.environment.recoverAttempts?.(remote.previousAttempts, cancellation.signal);
      await components.benchmark.verificationRuntime?.recoverAttempts?.(remote.previousAttempts, cancellation.signal);
      await runTask(remote.job, components, source, cancellation.signal, {
        ...(preparedTask ? { preparedTask } : {}),
        timeoutSeconds: remote.safeConfig.timeoutSeconds,
        ...(remote.safeConfig.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: remote.safeConfig.solveTimeoutSeconds }),
        ...(remote.safeConfig.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: remote.safeConfig.verifyTimeoutSeconds }),
        includeTaskAnswer: remote.safeConfig.includeTaskAnswer === true,
        sensitiveValues: secrets,
        onProgress: progress.observe,
      });
    }
    const record = (await components.store.listAttempts()).find(
      attempt => attempt.key.attemptId === key.attemptId,
    )?.record;
    if (!record) throw new Error("Ray task has no durable result");
    await components.dispose();
    components = undefined;
    uploading = true;
    await client.control("control", { key, nodeId, state: "uploading" }, AbortSignal.timeout(15_000));
    const evidence = join(root, key.runId, "tasks", safeTaskKey(key.taskId), "attempts", key.attemptId);
    const files = JSON.parse(await readFile(join(evidence, "files.json"), "utf8")) as FileManifest;
    const upload = validateUploadManifest({
      schemaVersion: 1,
      key,
      transferId: key.attemptId,
      ...files,
      result: record,
    });
    const receipt = await client.uploadAttempt(upload, evidence, AbortSignal.timeout(300_000));
    // Keep node files by default. Explicit receipt-gated cleanup is a separate action.
    return { receipt, nodeId, hostname, ...(warnings.size ? { warnings: [...warnings] } : {}) };
  } catch (error) {
    await mkdir(root, { recursive: true });
    const message = redactDiagnostic(error instanceof Error ? error.message : "Ray node failed", secrets);
    const failure = classifyError(error, { phase: "environment", component: "environment",
      secrets: secrets });
    await writeFile(join(root, "worker-error.json"), JSON.stringify({ key, message, failure, environmentTimeouts: preparationTiming?.environmentTimeouts }) + "\n");
    // The original error may contain a key in its cause; only return the sanitized message.
    throw Object.assign(new EvaluatorError(failure.code, message, failure.details), { environmentTimeouts: preparationTiming?.environmentTimeouts });
  } finally {
    cancellation.abort(new DOMException("Ray worker finished", "AbortError"));
    heartbeatStop.abort();
    await heartbeat;
    await progress.close();
    await components?.dispose();
  }
}

async function main(): Promise<void> {
  const filename = process.env.EVALUATOR_NODE_CONFIG;
  if (!filename) throw new Error("EVALUATOR_NODE_CONFIG is required");
  const node = parseNodeConfig(JSON.parse(await readFile(filename, "utf8")), dirname(resolve(filename)));
  process.env.EVALUATOR_CACHE_DIR ??= join(node.outputRoot, "cache");
  if (process.argv[2] === "--network-doctor") {
    const { NetworkRuntime } = await import("../network/runtime.js");
    const { diagnoseNetwork } = await import("../network/doctor.js");
    const { loadPackageDigest } = await import("../../core/package-provenance.js");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Network diagnosis input too large");
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    validateNetworkSnapshot(input.network);
    if (input.packageDigest !== await loadPackageDigest() || typeof input.location !== "string") throw new Error("Network diagnosis node package mismatch");
    const network = new NetworkRuntime(restoreNetworkTemplate(input.network.template, process.env));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    try {
      const results = await diagnoseNetwork(network, controller.signal, { benchmark: input.network.benchmarkName,
        location: input.location, ...(node.dockerExecutable ? { docker: node.dockerExecutable } : {}) });
      process.stdout.write(JSON.stringify(results) + "\n");
    } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); await network.dispose(); }
    return;
  }
  if (process.argv[2] === "--image-lease") {
    const { createInterface } = await import("node:readline");
    const { guardNodeImages } = await import("./image-cleanup-worker.js");
    const lines = createInterface({ input: process.stdin });
    const closed = Promise.withResolvers<void>();
    const payload = Promise.withResolvers<unknown>();
    let received = false;
    lines.on("line", line => {
      if (received || Buffer.byteLength(line) > 2 * 1024 * 1024) { payload.reject(new Error("Invalid image lease input")); lines.close(); return; }
      received = true;
      try { payload.resolve(JSON.parse(line)); } catch (error) { payload.reject(error); }
    });
    lines.on("close", () => { closed.resolve(); if (!received) payload.reject(new Error("Missing image lease input")); });
    const cancel = () => { closed.resolve(); lines.close(); };
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    console.log = console.info = console.warn = console.error = () => {};
    try { await guardNodeImages(await payload.promise, node, closed.promise, () => process.stdout.write("ready\n")); }
    finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); lines.close(); }
    return;
  }
  if (process.argv[2] === "--image-cleanup") {
    const { cleanupNodeImages } = await import("./image-cleanup-worker.js");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Image cleanup input too large");
      chunks.push(Buffer.from(chunk));
    }
    console.log = console.info = console.warn = console.error = () => {};
    const result = await cleanupNodeImages(JSON.parse(Buffer.concat(chunks).toString("utf8")), node);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const token = process.env[node.tokenEnv];
  if (!token) throw new Error("Ray transfer token is unavailable");
  delete process.env[node.tokenEnv];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Ray input too large");
    chunks.push(Buffer.from(chunk));
  }
  // Reserve stdout for the bridge response, including while third-party plugins load.
  console.log = console.info = console.warn = console.error = () => {};
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { remote?: unknown };
  const registry = await openPluginRegistry(node.pluginPatchPath);
  try {
    const result = await executeRemoteNode(input, node, token, registry);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    // Preflight can fail before executeRemoteNode has obtained runtime auth or
    // opened a run store. Preserve a bounded, credential-free diagnostic there too.
    const remote = validateRemoteJob(input.remote, (role, name) => registry.ctx.evaluator.configTransport(role, name));
    const root = join(node.outputRoot, "jobs", remote.job.attemptId);
    await mkdir(root, { recursive: true });
    const message = error instanceof Error ? error.message : "";
    const code = /(?:version mismatch|package .*digest|package provenance)/iu.test(message)
      ? "SOURCE_CHANGED"
      : classifyError(error, { phase: "environment" }).code;
    try {
      await writeFile(
        join(root, "worker-error.json"),
        JSON.stringify({
          key: { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId },
          code,
        }) + "\n",
        { flag: "wx" },
      );
    } catch (diagnosticError) {
      if ((diagnosticError as NodeJS.ErrnoException).code !== "EEXIST") throw diagnosticError;
    }
    // Only the canonical code and validated numeric timing evidence cross the boundary. Detailed causes
    // remain in the node's sanitized evidence, never in Ray exception strings.
    const failure = classifyError(error, { phase: "environment", component: "environment" });
    const environmentTimeouts = error && typeof error === "object" && "environmentTimeouts" in error ? error.environmentTimeouts : undefined;
    assertEnvironmentTimeouts(environmentTimeouts);
    process.stdout.write(JSON.stringify({ errorCode: code, ...(environmentTimeouts === undefined ? {} : { environmentTimeouts }), ...(code === "NETWORK_FAILURE" ? { network: failure.details } : {}) }) + "\n");
    throw error;
  } finally { await registry.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(() => {
    process.stderr.write("Ray node execution failed; retained node evidence may contain details.\n");
    process.exitCode = 1;
  });
