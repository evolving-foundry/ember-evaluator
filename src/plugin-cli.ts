import { pathToFileURL } from "node:url";
import type { PluginCliCommand, PluginCliOption, PluginCliRegistrar } from "./core/contracts/plugin-extension.js";
import { loadPluginPatch, resolvePlugin } from "./config/plugin-patch.js";
import { readPluginCatalog, type InstalledPlugin } from "./plugin-catalog.js";

export type CliExtensions = {
  commands: PluginCliCommand[];
  options: { id: string; command: "run"; option: PluginCliOption }[];
};

/** Only discovery flags are read here; Commander validates the complete argv later. */
export function cliPatchPath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    if (argv[i] === "--patch") return argv[i + 1];
    if (argv[i]?.startsWith("--patch=")) return argv[i]!.slice("--patch=".length);
  }
  return undefined;
}

/** --patch belongs to discovery even when the selected command belongs to a plugin. */
export function pluginCommandArguments(argv: string[]): string[] {
  const result: string[] = [];
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (value === "--") { result.push(...argv.slice(i)); break; }
    if (value === "--patch" || value.startsWith("--patch=")) {
      if (seen) throw new TypeError("Repeated --patch option");
      seen = true;
      const path = value === "--patch" ? argv[++i] : value.slice("--patch=".length);
      if (!path || path.startsWith("-")) throw new TypeError("--patch requires a path");
    } else result.push(value);
  }
  return result;
}

export async function loadCliExtensions(patchPath?: string, catalog: InstalledPlugin[] = readPluginCatalog()): Promise<CliExtensions> {
  const result: CliExtensions = { commands: [], options: [] };
  const ids = new Set<string>();
  const register = async (id: string, module: unknown) => {
    if (ids.has(id)) throw new TypeError(`Duplicate plugin id: ${id}`);
    ids.add(id);
    if (!module || (typeof module !== "object" && typeof module !== "function") || !("registerCli" in module)) return;
    if (typeof module.registerCli !== "function") throw new TypeError(`Plugin ${id}: registerCli must be a function`);
    const registrar: PluginCliRegistrar = {
      addCommand(command) { result.commands.push(command); },
      extendCommand(command, option) { result.options.push({ id, command, option }); },
    };
    await module.registerCli(registrar);
  };
  const patch = await loadPluginPatch(patchPath);
  const patchIds = new Set(patch.entries.map(entry => entry.id));
  for (const plugin of catalog) {
    if (patchIds.has(plugin.id)) throw new TypeError(`Duplicate installed/patch plugin id: ${plugin.id}`);
    // Declarative flags need no CLI module: the host registers them from the manifest.
    for (const flag of plugin.flags ?? []) result.options.push({ id: plugin.id, command: flag.command, option: {
      flags: flag.flag, description: flag.description,
      configure(value, activation) {
        activation.enable(typeof value === "string" && flag.config !== undefined ? { [flag.config]: value } : {});
      },
    } });
    if (plugin.cli) await register(plugin.id, await import(pathToFileURL(plugin.cli).href));
  }
  for (const entry of patch.entries) {
    const resolved = await resolvePlugin(entry, patch.patchPath!);
    await register(entry.id, resolved.plugin);
  }
  return result;
}
