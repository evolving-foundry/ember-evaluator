import { resolve } from "node:path";
import type { LoadedConfig } from "../../config/loaded.js";
import { recommendedNetworkConfigPath } from "../../config/network.js";
import { redactNetwork } from "../../config/network-schema.js";
import { NetworkRuntime } from "../../infrastructure/network/runtime.js";
import { diagnoseNetwork, type NetworkProbe } from "./network.js";
import { diagnoseRayNetwork } from "../ray/network-doctor.js";
import { formatError } from "../../core/errors/diagnostics.js";

function quoteArgument(value: string): string {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export async function diagnoseDownloads(options: { config: LoadedConfig; configPath: string; patchPath?: string },
  signal: AbortSignal, progress: (message: string) => void) {
  const { config } = options;
  const network = new NetworkRuntime(config.network);
  const configPath = network.document.origin;
  const recommendedConfigPath = recommendedNetworkConfigPath();
  progress(`Network configuration: ${configPath}`);
  const report = (probe: NetworkProbe) => {
    progress(`[${probe.status}] ${probe.name} (${probe.location}): ${probe.target}`);
    if (probe.status === "failed" || probe.status === "not-checked") {
      progress(probe.evidence);
      if (probe.guidance?.yamlFields.length) progress(`Edit ${configPath}: ${probe.guidance.yamlFields.join(", ")}`);
      if (probe.guidance) progress(probe.guidance.action);
    }
  };
  try {
    let probes: NetworkProbe[];
    if (config.experiment.scheduler.name === "ray") {
      try {
        probes = await diagnoseRayNetwork(config.experiment.scheduler.config, network,
          config.benchmarkName ?? config.experiment.benchmark.name, options.configPath, signal);
      } catch (error) {
        signal.throwIfAborted();
        probes = [{ name: "ray-network", location: "execution nodes", target: "Ray network probes", route: "Ray",
          status: "failed", elapsedMs: 0, evidence: formatError(error, network.secrets),
          guidance: { yamlFields: [], action: "Check the Ray endpoint and node deployment before changing download sources." } }];
      }
      probes.forEach(report);
    } else {
      const environment = config.experiment.environment;
      const source = config.experiment.benchmark.config.source;
      probes = await diagnoseNetwork(network, signal, {
        benchmark: config.benchmarkName ?? config.experiment.benchmark.name,
        ...(environment.name === "local" ? { docker: false } : typeof environment.config.dockerExecutable === "string"
          ? { docker: environment.config.dockerExecutable } : {}),
        ...(source && typeof source === "object" && "kind" in source && source.kind === "archive" && "url" in source && typeof source.url === "string"
          ? { datasetUrl: source.url } : {}),
        progress: report,
      });
    }
    const status = probes.some(row => row.status === "failed") ? "failed"
      : probes.some(row => row.status === "not-checked") ? "incomplete" : "passed";
    const experiment = quoteArgument(resolve(options.configPath));
    const patch = options.patchPath ? ` --patch ${quoteArgument(resolve(options.patchPath))}` : "";
    const retryCommand = `ember-evaluator doctor ${experiment}${patch} --network ${quoteArgument(configPath)}`;
    const recommendedCommand = `ember-evaluator doctor ${experiment}${patch} --network ${quoteArgument(recommendedConfigPath)}`;
    if (status !== "passed") {
      progress(`Retry after editing the fields above: ${retryCommand}`);
      progress(`To try the bundled mirror configuration: ${recommendedCommand}`);
      progress("The mirror configuration is optional; missing tools, credentials and Docker/Ray deployment failures require their own fixes.");
    }
    const proxy = network.settings.proxy.daemon;
    const dockerAdvice = redactNetwork({
      fields: ["proxy.overrides.daemon", "docker.pull", "docker.mirrors"],
      mergeIntoDaemonJson: { proxies: { "http-proxy": proxy.http ?? "", "https-proxy": proxy.https ?? "", "no-proxy": proxy.noProxy.join(",") } },
      instructions: ["Linux Engine: merge proxy settings into the daemon host's /etc/docker/daemon.json, preserving unrelated settings; validate before an administrator restarts Docker.",
        "Docker Desktop: apply proxies in Desktop Settings. Remote Docker: configure the daemon host, not this client.",
        "docker.mirrors controls explicit downloads; FROM and external COPY use the daemon. No daemon settings were changed or services restarted."] });
    if (status !== "passed" && config.experiment.environment.name === "docker") progress(JSON.stringify(dockerAdvice, null, 2));
    return { configPath, recommendedConfigPath, retryCommand, recommendedCommand, status, probes, dockerAdvice };
  } finally { await network.dispose(); }
}
