import { dirname, resolve } from "node:path";
import { createPluginRuntime } from "./plugins/create-components.js";
import { loadConfig } from "./config.js";
import type { LoadedConfig } from "../config/loaded.js";
import type { ImageCleanupSummary, ImageCleanupRequest } from "../core/contracts/image-cleanup.js";
import { fingerprintImageConfig } from "../core/policies/image-config.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";

export type CleanupOptions = { file?: string; all: boolean; execute: boolean; patchPath?: string;
  signal: AbortSignal; execution?: { config: LoadedConfig; registry: PluginRegistry }; onLoaded?: (config: LoadedConfig) => void };

export async function cleanupImages(options: CleanupOptions): Promise<ImageCleanupSummary> {
  const { signal } = options;
  if (!options.file) {
    if (!options.all) throw new TypeError("Image cleanup requires YAML or --all");
    const { DockerEnvironment } = await import("../plugins/environments/docker/environment.js");
    const result = await new DockerEnvironment().cleanupImages({ all: true, execute: options.execute }, signal);
    return { preview: !options.execute, nodes: [result] };
  }
  const registry = options.execution?.registry ?? await openPluginRegistry(options.patchPath);
  try {
    const file = resolve(options.file);
    const config = options.execution?.config ?? await loadConfig(file, {}, process.env,
      { registry, allowMissingAuth: true, ...(options.patchPath ? { patchPath: options.patchPath } : {}) });
    options.onLoaded?.(config);
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    const request: ImageCleanupRequest = { all: options.all, execute: options.execute,
      configFingerprint: fingerprintImageConfig(config.experiment as unknown as import("../core/contracts/task.js").JsonValue, lookup) };
    const runtime = createPluginRuntime(config, dirname(file), options.patchPath, undefined, lookup);
    if (config.deployment) {
      const { RayJobsDeployment } = await import("./ray/deployment.js");
      const { parseJobsConfig } = await import("../config/jobs.js");
      const { kind: _kind, ...connection } = config.deployment;
      const deployment = new RayJobsDeployment(parseJobsConfig({ ...connection, ...config.experiment.scheduler.config }), runtime, lookup);
      return await deployment.cleanupImages(config.experiment as unknown as import("../core/contracts/task.js").JsonValue,
        registry.pluginVersions, request, { signal, log() {} });
    }
    const scheduler = await registry.ctx.evaluator.prepare("scheduler", config.experiment.scheduler)(runtime);
    if (scheduler.executionLocation === "remote") {
      if (!scheduler.cleanupImages) throw new Error("Scheduler does not support image cleanup");
      return { preview: !request.execute, nodes: await scheduler.cleanupImages(request, config.experiment.environment, registry.pluginVersions, signal) };
    }
    const environment = await registry.ctx.evaluator.prepare("environment", config.experiment.environment)(runtime);
    if (!environment.cleanupImages) throw new Error("Environment does not support image cleanup");
    return { preview: !request.execute, nodes: [await environment.cleanupImages(request, signal)] };
  } finally { if (!options.execution) await registry.dispose(); }
}
