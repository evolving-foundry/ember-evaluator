import { validateNetworkSnapshot } from "../../config/network-schema.js";
import type { NetworkSnapshot } from "../../core/contracts/network.js";
import { join, posix, win32 } from "node:path";
import { parseHardware } from "../../config/hardware.js";
import type { ConfigTransportLookup } from "../../core/contracts/config-transport.js";
import type { EffectiveConfig, Selection } from "../../core/contracts/config.js";
import type { AttemptKey, RunManifest } from "../../core/contracts/result.js";
import type { TaskJob } from "../../core/contracts/scheduler.js";
import type { SourceLock, PhaseTimeoutOverrides } from "../../core/contracts/task.js";
import { assertSourceLock } from "../../core/results/source-lock.js";
import type { SolverProvenance } from "../../core/contracts/solver.js";
import { validateSolverProvenance } from "../../core/results/solver-provenance.js";
import { preparationTimeoutMs, preparationConcurrency } from "../../core/preparation/preparation-timeout.js";
import { fingerprintImageConfig } from "../../core/policies/image-config.js";

export type RemoteConfig = Pick<EffectiveConfig, "hardware" | "benchmark" | "environment" | "solver" | "verifier"> & PhaseTimeoutOverrides & {
  timeoutSeconds: number;
  includeTaskAnswer?: boolean;
  network?: NetworkSnapshot;
};
export type RemotePreparation = {
  roundId: string;
  deadlineAt: string | null;
  concurrency: number;
  defaultTimeoutSeconds: number;
  environmentTimeoutSeconds: number | null;
  nodeId: string;
  mode: "prepare" | "execute";
  digest: string | null;
};
export type RemoteJob = {
  imageConfigFingerprint?: string;
  schemaVersion: 1 | 2;
  preparation?: RemotePreparation;
  job: TaskJob;
  source: SourceLock;
  safeConfig: RemoteConfig;
  pluginVersions: Record<string, string>;
  packageDigest: string;
  uploadEndpoint: string;
  previousAttempts: AttemptKey[];
  solverProvenance?: SolverProvenance;
};

function object(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Invalid Ray protocol object");
  const record = value as Record<string, unknown>;
  if (
    fields &&
    (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key)))
  )
    throw new TypeError("Unknown or missing Ray protocol fields");
  return record;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
    throw new TypeError("Invalid Ray protocol string");
}
function safeId(value: unknown): void {
  text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value)) throw new TypeError("Invalid Ray run or attempt identity");
}
const secretKey = /(?:api.?key|secret|password|credential|authorization|(?:^|_)token(?:$|_))/iu;

/** Plugin values travel by value. Node-specific paths and credentials need a runtime mapping. */
function portable(value: unknown, path: string, containerPaths: readonly (readonly string[])[] = [], location: string[] = [], depth = 0): void {
  if (depth > 50) throw new TypeError("Ray configuration nesting limit exceeded");
  if (typeof value === "string") {
    if (/\u0000/u.test(value)) throw new TypeError(`Invalid value at ${path}`);
    const containerPath = containerPaths.some(pattern => pattern.length === location.length &&
      pattern.every((part, index) => part === "*" || part === location[index]));
    if (containerPath && (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || posix.normalize(value) !== value))
      throw new TypeError(`Invalid container path at ${path}`);
    if (!containerPath && (posix.isAbsolute(value) || win32.isAbsolute(value)))
      throw new TypeError(`Node-local path required at ${path}`);
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
      const url = new URL(value);
      if (url.username || url.password || [...url.searchParams.keys()].some(key => secretKey.test(key)))
        throw new TypeError(`Credential-bearing URL at ${path}`);
    }
    return;
  }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => portable(entry, `${path}[${index}]`, containerPaths, [...location, String(index)], depth + 1));
    return;
  }
  const record = object(value);
  for (const [key, entry] of Object.entries(record)) {
    if (secretKey.test(key)) throw new TypeError(`Credentials are forbidden in Ray payload at ${path}.${key}`);
    portable(entry, `${path}.${key}`, containerPaths, [...location, key], depth + 1);
  }
}
export function validatePortableSelection(value: unknown, role: string, lookup?: ConfigTransportLookup): Selection {
  const fields = ["name", "config"];
  if (role === "solver" || (role === "verifier" && Object.hasOwn(object(value), "service"))) fields.push("service");
  const record = object(value, fields);
  text(record.name);
  if (fields.includes("service")) text(record.service);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(record.name))
    throw new TypeError("Ray plugin selections must use registered names");
  const config = object(record.config);
  const transport = lookup?.(role, record.name);
  for (const [key, entry] of Object.entries(config)) {
    if (transport?.secretFields?.includes(key)) throw new TypeError("Credentials are forbidden in Ray plugin config");
    if (secretKey.test(key)) throw new TypeError("Credentials are forbidden in Ray plugin config");
    if (["cacheDir", "dockerExecutable"].includes(key) || Object.hasOwn(transport?.nodeLocal ?? {}, key))
      throw new TypeError("Node-local paths must not be serialized");
    portable(entry, `${role}.${key}`, transport?.containerPaths, [key]);
  }
  transport?.validate?.(structuredClone(config));
  return record as Selection;
}

/** Strip only fields declared by the installed component, then check the wire value. */
export function projectPortableSelection<T extends Selection>(selection: T, role: string, lookup?: ConfigTransportLookup): T {
  const projected = structuredClone(selection);
  for (const field of lookup?.(role, selection.name)?.secretFields ?? []) delete projected.config[field];
  for (const field of Object.keys(lookup?.(role, selection.name)?.nodeLocal ?? {})) delete projected.config[field];
  validatePortableSelection(projected, role, lookup);
  return projected;
}

/** Validate before adding host paths; the sender cannot supply these values. */
export function localizePortableSelection<T extends Selection>(selection: T, role: string,
  host: { outputRoot: string; dockerExecutable?: string }, lookup?: ConfigTransportLookup): T {
  validatePortableSelection(selection, role, lookup);
  const localized = structuredClone(selection);
  for (const [field, kind] of Object.entries(lookup?.(role, selection.name)?.nodeLocal ?? {})) {
    if (kind === "cache") localized.config[field] = join(host.outputRoot, "cache", role, selection.name);
    else if (host.dockerExecutable !== undefined) localized.config[field] = host.dockerExecutable;
  }
  return localized;
}

export function validateRemoteJob(value: unknown, lookup?: ConfigTransportLookup): RemoteJob {
  const fields = [
    "schemaVersion",
    "job",
    "source",
    "safeConfig",
    "pluginVersions",
    "packageDigest",
    "uploadEndpoint",
    "previousAttempts",
  ];
  if (Object.hasOwn(object(value), "solverProvenance")) fields.push("solverProvenance");
  if (Object.hasOwn(object(value), "preparation")) fields.push("preparation");
  if (Object.hasOwn(object(value), "imageConfigFingerprint")) fields.push("imageConfigFingerprint");
  const record = object(value, fields);
  if (record.imageConfigFingerprint !== undefined && (typeof record.imageConfigFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.imageConfigFingerprint))) throw new TypeError("Invalid image configuration fingerprint");
  if (Object.hasOwn(record, "solverProvenance")) validateSolverProvenance(record.solverProvenance);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) throw new TypeError("Unsupported Ray protocol version");
  if ((record.schemaVersion === 2) !== Object.hasOwn(record, "preparation"))
    throw new TypeError("Ray batch protocol requires preparation identity");
  if (record.preparation !== undefined) {
    const preparation = object(record.preparation, ["roundId", "deadlineAt", "nodeId", "mode", "digest", "concurrency", "defaultTimeoutSeconds", "environmentTimeoutSeconds"]);
    safeId(preparation.roundId);
    text(preparation.nodeId);
    if (typeof preparation.concurrency !== "number" || typeof preparation.defaultTimeoutSeconds !== "number" ||
      preparation.environmentTimeoutSeconds !== null && typeof preparation.environmentTimeoutSeconds !== "number")
      throw new TypeError("Invalid Ray preparation timeout");
    preparationConcurrency(preparation.concurrency, preparation.concurrency);
    preparationTimeoutMs(preparation.defaultTimeoutSeconds * Math.min(preparation.concurrency, 10));
    if (preparation.environmentTimeoutSeconds !== null)
      preparationTimeoutMs(preparation.environmentTimeoutSeconds * Math.min(preparation.concurrency, 10));
    if (preparation.deadlineAt !== null) text(preparation.deadlineAt);
    if (preparation.deadlineAt !== null && !Number.isFinite(Date.parse(preparation.deadlineAt)) ||
      (preparation.mode !== "prepare" && preparation.mode !== "execute") ||
      (preparation.mode === "prepare" ? preparation.digest !== null :
        typeof preparation.digest !== "string" || !/^[a-f0-9]{64}$/u.test(preparation.digest)))
      throw new TypeError("Invalid Ray preparation receipt");
  }
  const job = object(record.job, ["runId", "taskId", "attemptId", "ref", "configFingerprint"]);
  safeId(job.runId);
  safeId(job.attemptId);
  text(job.taskId);
  text(job.configFingerprint);
  const ref = object(job.ref, ["id", "recordKey"]);
  if (ref.id !== job.taskId) throw new TypeError("Ray task reference differs from task identity");
  portable(ref.recordKey, "recordKey");
  assertSourceLock(record.source);
  portable(record.source, "source");
  const configFields = ["benchmark", "environment", "solver", "timeoutSeconds"];
  for (const key of ["solveTimeoutSeconds", "verifyTimeoutSeconds"]) if (Object.hasOwn(object(record.safeConfig), key)) configFields.push(key);
  if (Object.hasOwn(object(record.safeConfig), "includeTaskAnswer")) configFields.push("includeTaskAnswer");
  if (Object.hasOwn(object(record.safeConfig), "verifier")) configFields.push("verifier");
  if (Object.hasOwn(object(record.safeConfig), "network")) configFields.push("network");
  if (Object.hasOwn(object(record.safeConfig), "hardware")) configFields.push("hardware");
  const config = object(record.safeConfig, configFields);
  if (config.network !== undefined) validateNetworkSnapshot(config.network);
  parseHardware(config.hardware);
  for (const key of ["solveTimeoutSeconds", "verifyTimeoutSeconds"]) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new TypeError(`Invalid Ray ${key}`);
  }
  if (Object.hasOwn(config, "includeTaskAnswer") && config.includeTaskAnswer !== true)
    throw new TypeError("run.includeTaskAnswer must be true when present");
  if (config.verifier !== undefined) validatePortableSelection(config.verifier, "verifier", lookup);
  for (const role of ["benchmark", "environment", "solver"]) validatePortableSelection(config[role], role, lookup);
  if (
    typeof config.timeoutSeconds !== "number" ||
    !Number.isFinite(config.timeoutSeconds) ||
    config.timeoutSeconds <= 0
  )
    throw new TypeError("Invalid Ray task timeout");
  const versions = object(record.pluginVersions);
  for (const [id, version] of Object.entries(versions)) {
    text(id);
    text(version);
  }
  if (typeof record.packageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.packageDigest))
    throw new TypeError("Invalid Ray package digest");
  text(record.uploadEndpoint);
  const endpoint = new URL(record.uploadEndpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError("Ray collector must be an HTTPS origin");
  if (!Array.isArray(record.previousAttempts) || record.previousAttempts.length > 10000)
    throw new TypeError("Invalid previous Ray attempts");
  const seen = new Set<string>();
  for (const previous of record.previousAttempts) {
    const key = object(previous, ["runId", "taskId", "attemptId"]);
    safeId(key.attemptId);
    if (
      key.runId !== job.runId ||
      key.taskId !== job.taskId ||
      key.attemptId === job.attemptId ||
      seen.has(key.attemptId as string)
    )
      throw new TypeError("Invalid previous Ray attempt identity");
    seen.add(key.attemptId as string);
  }
  return structuredClone(record) as RemoteJob;
}

export function projectRemoteJob(input: {
  job: TaskJob;
  run: Pick<RunManifest, "runId" | "source" | "configFingerprint" | "pluginVersions" | "solverProvenance">;
  config: EffectiveConfig;
  network?: NetworkSnapshot;
  packageDigest: string;
  uploadEndpoint: string;
  previousAttempts: AttemptKey[];
  configTransport?: ConfigTransportLookup;
}): RemoteJob {
  if (input.job.runId !== input.run.runId || input.job.configFingerprint !== input.run.configFingerprint)
    throw new TypeError("Ray job differs from its run");
  const benchmark = projectPortableSelection(input.config.benchmark, "benchmark", input.configTransport);
  const environment = projectPortableSelection(input.config.environment, "environment", input.configTransport);
  const solver = projectPortableSelection(input.config.solver, "solver", input.configTransport);
  const verifier = input.config.verifier ? projectPortableSelection(input.config.verifier, "verifier", input.configTransport) : undefined;
  return validateRemoteJob({
    schemaVersion: 1,
    job: input.job,
    imageConfigFingerprint: fingerprintImageConfig(input.config as unknown as import("../../core/contracts/task.js").JsonValue, input.configTransport),
    source: input.run.source,
    safeConfig: {
      ...(input.network ? { network: input.network } : {}),
      hardware: input.config.hardware ?? "npu",
      benchmark,
      environment,
      solver,
      ...(verifier ? { verifier } : {}),
      timeoutSeconds: input.config.run.timeoutSeconds,
      ...(input.config.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: input.config.run.solveTimeoutSeconds }),
      ...(input.config.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: input.config.run.verifyTimeoutSeconds }),
      ...(input.config.run.includeTaskAnswer === true ? { includeTaskAnswer: true } : {}),
    },
    pluginVersions: input.run.pluginVersions,
    packageDigest: input.packageDigest,
    ...(input.run.solverProvenance === undefined ? {} : { solverProvenance: input.run.solverProvenance }),
    uploadEndpoint: input.uploadEndpoint,
    previousAttempts: input.previousAttempts,
  }, input.configTransport);
}

export function assertWorkerVersions(
  expected: Record<string, string>,
  actual: Record<string, string>,
  expectedPackage: string,
  actualPackage: string,
): void {
  if (expectedPackage !== actualPackage) throw new Error("Ray package digest mismatch");
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  names.delete("cordis.patch.yaml");
  for (const name of names)
    if (expected[name] !== actual[name]) throw new Error(`Ray plugin version mismatch: ${name}`);
}
