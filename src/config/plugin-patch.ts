import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

import { expectNonEmptyString, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { BUILTIN_RUNTIME_ID } from "../core/results/runtime-identity.js";
import { PACKAGE_RUNTIME_ID } from "../core/results/runtime-identity.js";

export type PluginPatchEntry = {
  id: string;
  name: string;
};

export type LoadedPluginPatch = {
  entries: PluginPatchEntry[];
  patchDigest: string | null;
  patchPath: string | null;
};

export type ResolvedPlugin = {
  id: string;
  plugin: unknown;
  version: string;
};

export const PATCH_METADATA_ID = "cordis.patch.yaml";

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier);
}

function parsePatch(value: unknown): PluginPatchEntry[] {
  if (!Array.isArray(value)) throw new TypeError("cordis.patch.yaml must contain a list");
  const entries: PluginPatchEntry[] = [];
  for (const [operationIndex, operationValue] of value.entries()) {
    const operation = expectRecord(operationValue, `patch[${operationIndex}]`);
    rejectUnknown(operation, ["insert"], `patch[${operationIndex}]`);
    if (!Array.isArray(operation.insert)) {
      throw new TypeError(`patch[${operationIndex}].insert must be a list`);
    }
    for (const [entryIndex, entryValue] of operation.insert.entries()) {
      const entry = expectRecord(entryValue, `patch[${operationIndex}].insert[${entryIndex}]`);
      rejectUnknown(entry, ["id", "name"], `patch[${operationIndex}].insert[${entryIndex}]`);
      entries.push({
        id: expectNonEmptyString(entry.id, `patch insert ${entryIndex}.id`),
        name: expectNonEmptyString(entry.name, `patch insert ${entryIndex}.name`),
      });
    }
  }
  const ids = new Set<string>();
  for (const { id } of entries) {
    if (id === PATCH_METADATA_ID || id === BUILTIN_RUNTIME_ID || id === PACKAGE_RUNTIME_ID) {
      throw new TypeError(`plugin patch id ${id} is reserved for evaluator metadata`);
    }
    if (ids.has(id)) throw new TypeError(`duplicate plugin patch id: ${id}`);
    ids.add(id);
  }
  return entries;
}

export async function loadPluginPatch(path?: string): Promise<LoadedPluginPatch> {
  if (path === undefined) return { entries: [], patchDigest: null, patchPath: null };
  const patchPath = resolve(path);
  const raw = await readFile(patchPath, "utf8");
  return {
    entries: parsePatch(parse(raw, { maxAliasCount: 100 }) as unknown),
    patchDigest: digest(raw),
    patchPath,
  };
}

async function packageVersion(modulePath: string): Promise<string | null> {
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

export async function resolvePlugin(
  entry: PluginPatchEntry,
  patchPath: string,
): Promise<ResolvedPlugin> {
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
    version = (await packageVersion(modulePath)) ?? digest(await readFile(modulePath));
  }

  const namespace = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const plugin = namespace.default ?? namespace;
  return { id: entry.id, plugin, version };
}
