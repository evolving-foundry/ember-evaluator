import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginPatchEntry } from "../../config/plugin-patch.js";

export type LoadedPluginModule = {
  id: string;
  plugin: unknown;
  version: string;
};

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier);
}

async function readPackageVersion(modulePath: string): Promise<string | null> {
  let directory = dirname(modulePath);
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof pkg.version === "string") return pkg.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function loadPluginModule(
  entry: PluginPatchEntry,
  patchPath: string,
): Promise<LoadedPluginModule> {
  let modulePath: string;
  let version: string;
  if (isPathSpecifier(entry.name)) {
    modulePath = isAbsolute(entry.name) ? entry.name : resolve(dirname(patchPath), entry.name);
    if (extname(modulePath).toLowerCase() === ".ts") {
      throw new TypeError(`plugin ${entry.id} must be compiled to JavaScript`);
    }
    const content = await readFile(modulePath);
    version = digest(content);
  } else {
    const require = createRequire(join(dirname(resolve(patchPath)), "package.json"));
    modulePath = require.resolve(entry.name);
    if (extname(modulePath).toLowerCase() === ".ts") {
      throw new TypeError(`plugin ${entry.id} resolved to uncompiled TypeScript`);
    }
    version = (await readPackageVersion(modulePath)) ?? digest(await readFile(modulePath));
  }

  const namespace = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const plugin = namespace.default ?? namespace;
  return { id: entry.id, plugin, version };
}
