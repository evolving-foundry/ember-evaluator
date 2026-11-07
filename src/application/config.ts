import { networkSecrets } from "../config/network-schema.js";
import { readConfig, readSavedConfig, type ConfigReadOptions } from "../config/load.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";
import type { LoadedConfig } from "../config/loaded.js";
import type { CliOverrides } from "../core/contracts/config.js";

type LoadOptions = Omit<ConfigReadOptions, "registry"> & { patchPath?: string; registry?: PluginRegistry };

async function withRegistry<T>(options: LoadOptions, read: (options: ConfigReadOptions) => Promise<T>): Promise<T> {
  const registry = options.registry ?? await openPluginRegistry(options.patchPath);
  try {
    return await read({ ...options, registry: {
      profiles: () => registry.ctx.evaluator.profiles(),
      validate: (role, selection) => { registry.ctx.evaluator.prepare(role, selection); },
    } });
  } finally { if (!options.registry) await registry.dispose(); }
}

export function loadConfig(path: string, overrides: CliOverrides, env: Record<string, string | undefined>, options: LoadOptions = {}): Promise<LoadedConfig> {
  return withRegistry(options, readOptions => readConfig(path, overrides, env, readOptions));
}

export function loadSavedConfig(path: string, env: Record<string, string | undefined>, options: LoadOptions = {}): Promise<LoadedConfig> {
  return withRegistry(options, readOptions => readSavedConfig(path, env, readOptions));
}

export function loadedConfigSecrets(config: LoadedConfig): string[] {
  return [...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value)];
}
