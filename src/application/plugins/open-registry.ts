import { Context, type Plugin } from "@deepseek-ai/cordis";
import { loadPluginPatch, PATCH_METADATA_ID } from "../../config/plugin-patch.js";
import { BUILTIN_RUNTIME_ID, PACKAGE_RUNTIME_ID } from "../../core/results/runtime-identity.js";
import { loadBuiltinRuntimeDigest } from "../../infrastructure/provenance/builtin-runtime.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { apply as registryPlugin } from "./registry.js";
import * as builtins from "../../plugins/index.js";
import { validateProfiles } from "../../config/profile-schema.js";
import { loadPluginModule } from "./load-module.js";

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
): Promise<{
  patch: Awaited<ReturnType<typeof loadPluginPatch>>;
  pluginVersions: Record<string, string>;
  reportingProviders: Record<string, string>;
}> {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  const reportingProviders: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of patch.entries) {
    const previous = new Set(ctx.evaluator.entries().map(entry => `${entry.role}:${entry.name}`));
    if (patch.patchPath === null) throw new TypeError("plugin patch entries require an explicit patch path");
    const loaded = await loadPluginModule(entry, patch.patchPath);
    pluginVersions[loaded.id] = loaded.version;
    await ctx.plugin(asCordisPlugin(loaded.plugin, loaded.id));
    for (const selection of ctx.evaluator.entries()) {
      if ((selection.role === "metrics" || selection.role === "reporter") && !previous.has(`${selection.role}:${selection.name}`)) {
        reportingProviders[`${selection.role}:${selection.name}`] = entry.id;
      }
    }
  }
  return { patch, pluginVersions, reportingProviders };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export async function openPluginRegistry(patchPath?: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(registryPlugin);
    await ctx.plugin(builtins);
    const metadata = await loadExperimentPlugins(ctx, patchPath);
    validateProfiles(ctx.evaluator.profiles());
    let disposed = false;
    return {
      ctx,
      ...metadata,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export type PluginRegistry = Awaited<ReturnType<typeof openPluginRegistry>>;
