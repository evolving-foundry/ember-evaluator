import { assertJsonValue, expectNonEmptyString, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { type Selection } from "../core/contracts/config.js";
import type { BenchmarkSelection, UserConfig } from "./user-schema.js";

export type ProfileRole = "benchmark" | "solver";
export type ProfileDefaults = Omit<Partial<UserConfig>, "benchmark"> & { benchmark?: string | Partial<BenchmarkSelection> };
export type ProfileLayer = {
  plugin?: Selection;
  defaults?: ProfileDefaults;
  metricAliases?: Record<string, Selection>;
};
export type ConfigProfile = ProfileLayer & {
  id: string;
  role: ProfileRole;
  extends?: string;
  defaultVersion?: string;
  defaultScenario?: string;
  versions?: Record<string, ProfileLayer>;
  scenarios?: Record<string, ProfileLayer>;
};
export type ResolvedProfiles = readonly ConfigProfile[];

function layer(value: unknown, path: string): ProfileLayer {
  const record = expectRecord(value, path);
  rejectUnknown(record, ["plugin", "defaults", "metricAliases"], path);
  const result: ProfileLayer = {};
  if (record.plugin !== undefined) {
    const plugin = expectRecord(record.plugin, `${path}.plugin`);
    rejectUnknown(plugin, ["name", "config"], `${path}.plugin`);
    result.plugin = { name: expectNonEmptyString(plugin.name, `${path}.plugin.name`),
      config: plugin.config === undefined ? {} : expectRecord(plugin.config, `${path}.plugin.config`) };
  }
  if (record.defaults !== undefined) {
    const defaults = expectRecord(record.defaults, `${path}.defaults`);
    rejectUnknown(defaults, ["hardware", "benchmark", "environment", "scheduler", "store", "reporter", "metrics", "run", "output"], `${path}.defaults`);
    // Defaults are partial user input; the complete merged input is checked before use.
    result.defaults = defaults;
  }
  if (record.metricAliases !== undefined) {
    result.metricAliases = {};
    for (const [name, selection] of Object.entries(expectRecord(record.metricAliases, `${path}.metricAliases`))) {
      const parsed = layer({ plugin: selection }, `${path}.metricAliases.${name}`).plugin;
      if (parsed) result.metricAliases[name] = parsed;
    }
  }
  return result;
}

export function parseConfigProfile(value: unknown): ConfigProfile {
  assertJsonValue(value, "profile");
  const record = expectRecord(value, "profile");
  rejectUnknown(record, ["id", "role", "extends", "plugin", "defaults", "metricAliases", "defaultVersion", "defaultScenario", "versions", "scenarios"], "profile");
  if (record.role !== "benchmark" && record.role !== "solver") throw new TypeError("profile.role must be benchmark or solver");
  const result: ConfigProfile = { id: expectNonEmptyString(record.id, "profile.id"), role: record.role,
    ...layer(Object.fromEntries(["plugin", "defaults", "metricAliases"].filter(key => record[key] !== undefined).map(key => [key, record[key]])), "profile") };
  for (const key of ["extends", "defaultVersion", "defaultScenario"] as const)
    if (record[key] !== undefined) result[key] = expectNonEmptyString(record[key], `profile.${key}`);
  for (const key of ["versions", "scenarios"] as const) {
    if (record[key] !== undefined) result[key] = Object.fromEntries(Object.entries(expectRecord(record[key], `profile.${key}`))
      .map(([id, item]) => [id, layer(item, `profile.${key}.${id}`)]));
  }
  return structuredClone(result);
}

export function profileChain(profiles: ResolvedProfiles, role: ProfileRole, id: string): ConfigProfile[] {
  const active = new Set<string>();
  const visit = (name: string): ConfigProfile[] => {
    if (active.has(name)) throw new TypeError(`profile inheritance cycle: ${[...active, name].join(" -> ")}`);
    const profile = profiles.find(item => item.role === role && item.id === name);
    if (!profile) throw new TypeError(`unknown ${role} profile: ${name}`);
    active.add(name);
    const parents = profile.extends === undefined ? [] : visit(profile.extends);
    active.delete(name);
    return [...parents, profile];
  };
  return visit(id);
}

export function validateProfiles(profiles: ResolvedProfiles): void {
  const seen = new Set<string>();
  for (const profile of profiles) {
    const key = `${profile.role}:${profile.id}`;
    if (seen.has(key)) throw new TypeError(`duplicate profile registration: ${key}`);
    seen.add(key);
    profileChain(profiles, profile.role, profile.id);
  }
}
