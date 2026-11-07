import { evidencePath } from "../../../../../core/artifacts/artifacts.js";
import { expectNonEmptyString, expectPositiveInteger, expectPositiveNumber, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";
import type { DirectorySource } from "../../../../../infrastructure/datasets/sources/directory.js";
import { validateStateProfile, type HarborStateProfile } from "./compatibility.js";
import { posix } from "node:path";

export type HarborConfig = {
  dataset: string;
  cacheDir: string;
  source?: DirectorySource;
  tasks: { root: string; id: "directory" | "task.name" | "metadata.task_id"; expectedCount?: number; requireTestScript: boolean; metadataFields: string[] };
  defaults: { workdir?: string; buildTimeoutSeconds: number; artifactPaths?: string[]; timeoutMultiplier?: number;
    agentUser?: string; verifierUser?: string; scoreAfterSolveFailure?: boolean };
  scoring: { primary: string; passThreshold: number; errorValues: number[] };
  taskProfiles?: Record<string, HarborStateProfile>;
};

function relativePath(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  return path === "." ? path : evidencePath(path);
}

export function parseHarborConfig(value: unknown): HarborConfig {
  const config = expectRecord(value, "harbor");
  if (Object.hasOwn(config, "environmentBuildTimeoutMultiplier"))
    throw new TypeError("harbor.environmentBuildTimeoutMultiplier was removed; use run.preparation.environmentTimeoutSeconds for a per-environment base or run.preparation.roundTimeoutSeconds for a round limit");
  rejectUnknown(config, ["dataset", "cacheDir", "source", "tasks", "defaults", "scoring", "taskProfiles"], "harbor");
  let source: DirectorySource | undefined;
  if (config.source !== undefined) {
    const original = expectRecord(config.source, "harbor.source");
    const { hostPlatform, ...input } = original;
    if (hostPlatform !== undefined && hostPlatform !== "linux" && hostPlatform !== "win32" && hostPlatform !== "darwin") throw new TypeError("Invalid source.hostPlatform");
    if (input.kind === "local") {
      rejectUnknown(input, ["kind", "path"], "harbor.source");
      source = { kind: "local", path: expectNonEmptyString(input.path, "source.path") };
    } else if (input.kind === "github") {
      rejectUnknown(input, ["kind", "repository", "revision", "path", "exclude"], "harbor.source");
      const repository = expectNonEmptyString(input.repository, "source.repository");
      const revision = expectNonEmptyString(input.revision, "source.revision");
      if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(revision))
        throw new TypeError("GitHub source requires owner/repository and an immutable 40-character commit");
      source = { kind: "github", repository, revision, path: relativePath(input.path ?? ".", "source.path") };
      if (input.exclude !== undefined) {
        if (!Array.isArray(input.exclude)) throw new TypeError("source.exclude must be an array of repository-relative paths");
        source.exclude = input.exclude.map(path => evidencePath(expectNonEmptyString(path, "source.exclude")));
        if (new Set(source.exclude).size !== source.exclude.length) throw new TypeError("Duplicate source.exclude path");
      }
    } else if (input.kind === "archive") {
      rejectUnknown(input, ["kind", "url", "sha256", "root"], "harbor.source");
      const url = expectNonEmptyString(input.url, "source.url");
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new TypeError("Archive source must use an HTTP(S) URL without credentials");
      const sha256 = expectNonEmptyString(input.sha256, "source.sha256");
      if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError("Invalid source.sha256");
      source = { kind: "archive", url, sha256, root: relativePath(input.root ?? ".", "source.root") };
    } else throw new TypeError("source.kind must be local, github or archive; omit source to use the Harbor registry");
    if (hostPlatform !== undefined) source.hostPlatform = hostPlatform;
  }
  const tasks = expectRecord(config.tasks ?? {}, "harbor.tasks");
  rejectUnknown(tasks, ["root", "id", "expectedCount", "requireTestScript", "metadataFields"], "harbor.tasks");
  const id = tasks.id ?? "task.name";
  if (id !== "directory" && id !== "task.name" && id !== "metadata.task_id") throw new TypeError("Invalid tasks.id");
  if (tasks.requireTestScript !== undefined && typeof tasks.requireTestScript !== "boolean") throw new TypeError("Invalid tasks.requireTestScript");
  const metadataFields = tasks.metadataFields ?? [];
  if (!Array.isArray(metadataFields) || metadataFields.some(field => typeof field !== "string" || !/^[A-Za-z_]\w*$/u.test(field))) throw new TypeError("Invalid tasks.metadataFields");
  if (metadataFields.some(field => ["steps", "interaction", "services", "mcp_servers"].includes(String(field)))) throw new TypeError("Execution capabilities cannot be treated as metadata");
  const defaults = expectRecord(config.defaults ?? {}, "harbor.defaults");
  rejectUnknown(defaults, ["workdir", "buildTimeoutSeconds", "artifactPaths", "timeoutMultiplier", "agentUser", "verifierUser", "scoreAfterSolveFailure"], "harbor.defaults");
  for (const field of ["agentUser", "verifierUser"] as const) if (defaults[field] !== undefined &&
    (typeof defaults[field] !== "string" || !/^[a-z_][a-z0-9_-]*$/u.test(defaults[field]))) throw new TypeError(`Invalid defaults.${field}`);
  if (defaults.scoreAfterSolveFailure !== undefined && typeof defaults.scoreAfterSolveFailure !== "boolean") throw new TypeError("Invalid defaults.scoreAfterSolveFailure");
  const artifactPaths = defaults.artifactPaths;
  if (artifactPaths !== undefined && (!Array.isArray(artifactPaths) || artifactPaths.some(value =>
    typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value === "/" ||
    /[\\\0]/u.test(value) || posix.normalize(value) !== value) || new Set(artifactPaths).size !== artifactPaths.length))
    throw new TypeError("Invalid harbor.defaults.artifactPaths; expected distinct absolute container paths");
  const scoring = expectRecord(config.scoring ?? {}, "harbor.scoring");
  rejectUnknown(scoring, ["primary", "passThreshold", "errorValues"], "harbor.scoring");
  const threshold = scoring.passThreshold ?? 1;
  const errors = scoring.errorValues ?? [];
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || !Array.isArray(errors) ||
      errors.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new TypeError("Invalid Harbor scoring policy");
  const taskProfiles = Object.fromEntries(Object.entries(expectRecord(config.taskProfiles ?? {}, "taskProfiles")).map(([id, value]) => {
    const profile = expectRecord(value, `taskProfiles.${id}`);
    rejectUnknown(profile, ["workdir", "extraPaths"], "state profile");
    const extraPaths = profile.extraPaths ?? [];
    if (!Array.isArray(extraPaths) || extraPaths.some(path => typeof path !== "string")) throw new TypeError("Invalid state profile extraPaths");
    const result = { workdir: expectNonEmptyString(profile.workdir, "profile.workdir"), extraPaths: extraPaths as string[] };
    validateStateProfile(result);
    return [id, result];
  }));
  return {
    dataset: expectNonEmptyString(config.dataset ?? "terminal-bench@2.0", "harbor.dataset"),
    cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/harbor", "harbor.cacheDir"),
    ...(source ? { source } : {}),
    tasks: { root: relativePath(tasks.root ?? "tasks", "tasks.root"), id, requireTestScript: tasks.requireTestScript === true, metadataFields: metadataFields as string[],
      ...(tasks.expectedCount === undefined ? {} : { expectedCount: expectPositiveInteger(tasks.expectedCount, "tasks.expectedCount") }) },
    defaults: { buildTimeoutSeconds: expectPositiveNumber(defaults.buildTimeoutSeconds ?? 600, "defaults.buildTimeoutSeconds"),
      ...(defaults.timeoutMultiplier === undefined ? {} : { timeoutMultiplier: expectPositiveNumber(defaults.timeoutMultiplier, "defaults.timeoutMultiplier") }),
      ...(typeof defaults.agentUser === "string" ? { agentUser: defaults.agentUser } : {}),
      ...(typeof defaults.verifierUser === "string" ? { verifierUser: defaults.verifierUser } : {}),
      ...(typeof defaults.scoreAfterSolveFailure === "boolean" ? { scoreAfterSolveFailure: defaults.scoreAfterSolveFailure } : {}),
      ...(artifactPaths === undefined ? {} : { artifactPaths: artifactPaths as string[] }),
      ...(defaults.workdir === undefined ? {} : { workdir: expectNonEmptyString(defaults.workdir, "defaults.workdir") }) },
    scoring: { primary: expectNonEmptyString(scoring.primary ?? "reward", "scoring.primary"), passThreshold: threshold, errorValues: errors as number[] },
    taskProfiles,
  };
}
