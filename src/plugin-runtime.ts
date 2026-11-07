import { Context, type Plugin } from "@deepseek-ai/cordis";
import { loadPluginPatch, PATCH_METADATA_ID, resolvePlugin } from "./config/plugin-patch.js";
import { BUILTIN_RUNTIME_ID, loadBuiltinRuntimeDigest } from "./core/builtin-runtime.js";
import { PACKAGE_RUNTIME_ID, loadPackageDigest } from "./core/package-provenance.js";
import { apply as registryPlugin } from "./core/registry.js";
import { readPluginCatalog, loadInstalledPlugin } from "./plugin-catalog.js";
import type { PluginActivation } from "./core/contracts/plugin-extension.js";
import * as builtins from "./plugins/index.js";
import { expectRecord } from "./config/schema.js";
import { validateProfiles } from "./config/profiles.js";

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
  options: PluginRuntimeOptions = {},
) {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  const catalog = readPluginCatalog();
  const reportingProviders: Record<string, string> = Object.create(null) as Record<string, string>;
  const decorators = new Map<string, string[]>();
  const loaded = new Set<string>();
  const patchIds = new Set(patch.entries.map(entry => entry.id));
  for (const item of catalog) if (patchIds.has(item.id)) throw new TypeError(`Duplicate installed/patch plugin id: ${item.id}`);
  async function register(id: string, version: string, plugin: unknown) {
    const previous = new Set(ctx.evaluator.entries().map(entry => `${entry.role}:${entry.name}`));
    const before = new Set(ctx.evaluator.storeDecoratorNames());
    await ctx.plugin(asCordisPlugin(plugin, id));
    pluginVersions[id] = version;
    loaded.add(id);
    decorators.set(id, ctx.evaluator.storeDecoratorNames().filter(name => !before.has(name)));
    for (const selection of ctx.evaluator.entries())
      if ((selection.role === "metrics" || selection.role === "reporter") && !previous.has(`${selection.role}:${selection.name}`))
        reportingProviders[`${selection.role}:${selection.name}`] = id;
  }
  for (const entry of patch.entries) {
    if (patch.patchPath === null) throw new TypeError("Plugin patch entries require an explicit path");
    const resolved = await resolvePlugin(entry, patch.patchPath);
    await register(resolved.id, resolved.version, resolved.plugin);
  }
  async function loadPlugins(ids: readonly string[]) {
    for (const id of ids) {
      if (loaded.has(id)) continue;
      const installed = catalog.find(plugin => plugin.id === id);
      if (!installed) throw new TypeError(`Plugin ${id} is not installed; rebuild the package or supply --patch`);
      await register(id, installed.version, await loadInstalledPlugin(installed));
    }
    validateProfiles(ctx.evaluator.profiles());
  }
  // Nodes import only preinstalled modules identified by the coordinator's locked versions.
  // Importing registers factories; it does not activate coordinator-only extensions.
  async function loadRecordedPlugins(value: unknown) {
    const versions = expectRecord(value, "recorded plugin versions");
    if (Object.values(versions).some(version => typeof version !== "string")) throw new TypeError("Invalid recorded plugin version");
    await loadPlugins(catalog.filter(plugin => Object.hasOwn(versions, plugin.id)).map(plugin => plugin.id));
  }
  function prepareStoreDecorators(selections: readonly PluginActivation[]) {
    return selections.flatMap(selection => {
      if (!loaded.has(selection.id)) throw new TypeError(`Plugin ${selection.id} has not been loaded`);
      return (decorators.get(selection.id) ?? []).map(name => ctx.evaluator.prepareStoreDecorator(name, selection.config));
    });
  }
  await loadPlugins(options.plugins ?? []);
  return { patch, pluginVersions, reportingProviders, loadPlugins, loadRecordedPlugins, prepareStoreDecorators };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export type PluginRuntimeOptions = {
  /** Installed or explicit patch plugin IDs; registering does not activate their extensions. */
  plugins?: string[];
};

export async function openPluginRegistry(patchPath?: string, options: PluginRuntimeOptions = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(registryPlugin);
    await ctx.plugin(builtins);
    const metadata = await loadExperimentPlugins(ctx, patchPath, options);
    validateProfiles(ctx.evaluator.profiles());
    let disposed = false;
    return { ctx, ...metadata, async dispose() {
      if (disposed) return;
      disposed = true;
      await ctx.fiber.dispose();
    } };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export type PluginRegistry = Awaited<ReturnType<typeof openPluginRegistry>>;
