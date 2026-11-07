import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

import { expectNonEmptyString, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { BUILTIN_RUNTIME_ID, PACKAGE_RUNTIME_ID } from "../core/results/runtime-identity.js";

export type PluginPatchEntry = {
  id: string;
  name: string;
};

export type LoadedPluginPatch = {
  entries: PluginPatchEntry[];
  patchDigest: string | null;
  patchPath: string | null;
};

export const PATCH_METADATA_ID = "cordis.patch.yaml";

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
    patchDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    patchPath,
  };
}
