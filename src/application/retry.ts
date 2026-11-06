import { expectRecord } from "../core/validation/input.js";
import { openPluginRegistry } from "./plugins/runtime.js";
import { fingerprintConfig, fingerprintResumeConfig } from "../core/results/run-manifest.js";
import { redactDiagnostic } from "../core/errors/diagnostics.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunManifest } from "../core/contracts/result.js";
import { gatewayRun, locateRun } from "../infrastructure/filesystem/run-index.js";
import { submitRetry, controlTransaction } from "./retry-control/mailbox.js";
import { isManualRetryEligible } from "../core/recovery/manual-retry.js";
import { identifyNetworkFailure } from "../core/errors/network-failure.js";
import { loadSavedConfig } from "./config.js";
import { loadNetworkConfig } from "../config/network.js";
import { bootstrap, createPluginRuntime } from "./plugins/bootstrap.js";
import { runEngine } from "./run-engine.js";
import { saveReport } from "./report/index.js";
import type { ProgressListener } from "../core/progress/progress.js";

async function requireCredentialReferences(path: string): Promise<void> {
  const saved = expectRecord(JSON.parse(await readFile(path, "utf8")), "saved configuration");
  const services = expectRecord(saved.services, "saved services");
  const names = [expectRecord(saved.solver, "saved solver").service,
    ...(saved.verifier ? [expectRecord(saved.verifier, "saved verifier").service] : []),
    expectRecord(expectRecord(saved.benchmark, "saved benchmark").config, "saved benchmark.config").judgeService];
  for (const name of names) if (typeof name === "string" && expectRecord(services[name], "saved service").apiKey === "[runtime-provided]")
    throw new Error("Original run used a runtime-only credential without an environment reference");
}

export async function retryRun(options: { networkConfigPath?: string; run: string; taskIds: string[]; requestId?: string; reason?: string },
  signal: AbortSignal, log: (text: string) => void, onProgress?: ProgressListener): Promise<number> {
  const gateway = await gatewayRun(options.run);
  if (gateway) {
    await requireCredentialReferences(gateway.gatewayConfig);
    const config = await loadSavedConfig(gateway.gatewayConfig, process.env, { network: await loadNetworkConfig(options.networkConfigPath), configDirectory: gateway.configDirectory, ...(gateway.patchPath ? { patchPath: gateway.patchPath } : {}) });
    const registry = await openPluginRegistry(gateway.patchPath);
    try {
      if (!config.deployment) throw new Error("Saved run has no Ray Jobs deployment");
      const { RayJobsDeployment } = await import("./ray/deployment.js");
      const { parseJobsConfig } = await import("../config/jobs.js");
      const { kind: _kind, ...connection } = config.deployment;
      const deployment = new RayJobsDeployment(parseJobsConfig({ ...connection, ...config.experiment.scheduler.config }),
        createPluginRuntime(config, gateway.configDirectory, gateway.patchPath));
      return await deployment.retryExperiment(options.run, gateway.jobId, { taskIds: options.taskIds, signal, log, pluginVersions: registry.pluginVersions,
        ...(onProgress ? { onProgress } : {}),
        ...(options.requestId ? { requestId: options.requestId } : {}), ...(options.reason ? { reason: redactDiagnostic(options.reason, Object.values(config.auths).map(auth => auth.value)) } : {}) });
    } finally { await registry.dispose(); }
  }
  const directory = await locateRun(options.run);
  await requireCredentialReferences(join(directory, "config.yaml"));
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as RunManifest;
  const configDirectory = manifest.pluginRuntime?.configDirectory ?? dirname(directory);
  const patchPath = manifest.pluginRuntime?.patchPath;
  // Rebind original service references before admitting work; no model overrides are accepted.
  const config = await loadSavedConfig(join(directory, "config.yaml"), process.env, {
    network: await loadNetworkConfig(options.networkConfigPath), validatePlugins: true, ...(patchPath ? { patchPath } : {}), configDirectory,
  });
  if (fingerprintResumeConfig(config.persisted) !== manifest.configFingerprint) throw new Error("Retry configuration differs from locked run");
  const registry = await openPluginRegistry(patchPath);
  try {
    if (fingerprintConfig(registry.pluginVersions) !== fingerprintConfig(manifest.pluginVersions)) throw new Error("Retry plugin/execution versions differ from locked run");
  } finally { await registry.dispose(); }
  const submitted = await submitRetry(directory, { taskIds: options.taskIds,
    ...(options.requestId ? { requestId: options.requestId } : {}), ...(options.reason ? { reason: redactDiagnostic(options.reason, Object.values(config.auths).map(auth => auth.value)) } : {}) }, { signal });
  log(`Request ${submitted.request.requestId}: ${submitted.request.status}; ${directory}`);
  if (submitted.active || submitted.request.status !== "pending") return 0;
  const components = await bootstrap(config, configDirectory, patchPath);
  try {
    // The engine owns the exclusive RunStore lock; a second CLI cannot write results.
    await components.store.open(directory);
    const snapshot = await components.store.snapshot();
    const selected = snapshot.records.filter(record => isManualRetryEligible(record) && (!options.taskIds.length || options.taskIds.includes(record.key.taskId)));
    const sourceFailure = !snapshot.run.source && snapshot.run.failure?.code === "NETWORK_FAILURE" && identifyNetworkFailure([
      snapshot.run.failure, ...(snapshot.run.failure.causes ?? []),
    ], { phase: "prepare", component: "source" }) !== null;
    await components.store.close();
    if (!selected.length && !sourceFailure) {
      await controlTransaction(directory, async state => {
        const request = state.requests.find(item => item.requestId === submitted.request.requestId)!;
        request.status = "rejected"; request.message = "No current eligible network failures";
      });
      log("No current tasks qualify for network recovery; no attempt was created."); return 0;
    }
    const result = await runEngine({ components, config, signal, resumeDirectory: directory,
      ...(sourceFailure ? {} : { retryTaskIds: selected.map(record => record.key.taskId) }), retryRequestId: submitted.request.requestId,
      ...(onProgress ? { onProgress } : {}) });
    await saveReport(components.store, components.metrics, components.reporter);
    log(`Run ${result.run.runId}: ${result.run.status}; ${join(directory, "report.md")}`);
    return result.run.status === "completed" ? 0 : result.run.status === "cancelled" ? 130 : 1;
  } finally { await components.dispose(); }
}
