import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import type { AttemptKey, AttemptRecord, FileEntry, FileManifest } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { assertAttemptRecord } from "../../core/results/record-validation.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";

export type UploadManifest = {
  schemaVersion: 1;
  key: AttemptKey;
  transferId: string;
  files: FileEntry[];
  missing: FileManifest["missing"];
  result: AttemptRecord;
};
export type UploadReceipt = {
  schemaVersion: 1;
  transferId: string;
  key: AttemptKey;
  manifestDigest: string;
  accepted: boolean;
  receipt: string;
};
export class TransferError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "TransferError";
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  const fields = object(value) ? Object.keys(value) : null;
  if (
    fields === null ||
    fields.length !== keys.length ||
    fields.some(key => !keys.includes(key))
  )
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Unknown or missing protocol fields");
}
export function transferId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value))
    throw new TransferError("CONFIG_INVALID", "Unsafe transfer ID");
  return value;
}
export function validateTransferPath(value: unknown, missing = false): string {
  if (missing && value === ".evaluator-inventory-error") return value;
  if (typeof value !== "string" || value.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(value))
    throw new TransferError("TRANSFER_UNSAFE", "Unsafe transfer path");
  const parts = value.split("/");
  const allowedRoot =
    ["agent", "verifier", "artifacts"].includes(parts[0]!) ||
    (parts[0] === "logs" && parts[1] === "artifacts" && (missing || parts.length >= 3));
  if (
    !allowedRoot ||
    (!missing && parts.length < 2) ||
    parts.some(
      part =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  ) {
    throw new TransferError("TRANSFER_UNSAFE", "Unsafe or undeclared transfer path");
  }
  return value;
}
export function validateUploadManifest(value: unknown): UploadManifest {
  exact(value, ["schemaVersion", "key", "transferId", "files", "missing", "result"]);
  if (value.schemaVersion !== 1) throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Unsupported transfer protocol version");
  transferId(value.transferId);
  exact(value.key, ["runId", "taskId", "attemptId"]);
  const key = value.key;
  if (
    !["runId", "taskId", "attemptId"].every(
      name => typeof key[name] === "string" && key[name].length > 0 && key[name].length <= 4096,
    )
  )
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid attempt identity");
  for (const name of ["runId", "attemptId"])
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value.key[name] as string) ||
      (value.key[name] as string).endsWith(".")
    )
      throw new TransferError("CONFIG_INVALID", "Unsafe attempt identity");
  if (!object(value.result)) throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid uploaded attempt record");
  const uploadedResult = value.result;
  const optionalResultFields = ["accounting", "warnings", "trajectory", "readiness", "task"];
  exact(value.result, [
    "key",
    "evaluationKind",
    "executionStatus",
    "scoreStatus",
    "cleanupStatus",
    "solve",
    "verdict",
    "errors",
    "collection",
    "environments",
    "startedAt",
    "finishedAt",
    "durationMs",
    "phaseDurationMs",
    ...optionalResultFields.filter(field => Object.hasOwn(uploadedResult, field)),
  ]);
  try {
    assertAttemptRecord(value.result);
  } catch (error) {
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid uploaded attempt record", 400, error);
  }
  const result = value.result;
  if (Object.entries(value.key).some(([name, field]) => field !== result.key[name as keyof AttemptKey]))
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Upload result differs from attempt identity");
  if (
    !Array.isArray(value.files) ||
    !Array.isArray(value.missing) ||
    value.files.length + value.missing.length > 10_000
  )
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid evidence entry count");
  const leaves = new Set<string>();
  const parents = new Set<string>();
  const spellings = new Map<string, string>();
  function uniquePath(path: string) {
    const folded = path.toLowerCase();
    const parts = folded.split("/");
    const original = path.split("/");
    for (let i = 1; i <= original.length; i++) {
      const prefix = original.slice(0, i).join("/");
      const normalized = prefix.toLowerCase();
      const old = spellings.get(normalized);
      if (old !== undefined && old !== prefix) throw new TransferError("TRANSFER_UNSAFE", "Case-colliding evidence paths");
      spellings.set(normalized, prefix);
    }
    if (leaves.has(folded) || parents.has(folded))
      throw new TransferError("TRANSFER_UNSAFE", "Conflicting evidence paths");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (leaves.has(parent)) throw new TransferError("TRANSFER_UNSAFE", "Conflicting parent evidence path");
      parents.add(parent);
    }
    leaves.add(folded);
  }
  for (const entry of value.files) {
    exact(entry, ["path", "size", "sha256"]);
    uniquePath(validateTransferPath(entry.path));
    if (
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
      throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Invalid evidence size or checksum");
  }
  for (const entry of value.missing) {
    exact(entry, ["path", "reason"]);
    uniquePath(validateTransferPath(entry.path, true));
    if (typeof entry.reason !== "string" || !entry.reason || entry.reason.length > 4096)
      throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Missing evidence requires a bounded reason");
  }
  return structuredClone(value) as UploadManifest;
}
export function uploadDigest(manifest: UploadManifest): string {
  return fingerprintConfig(manifest as unknown as JsonValue);
}
export function createReceipt(manifest: UploadManifest, accepted: boolean): UploadReceipt {
  const manifestDigest = uploadDigest(manifest);
  return {
    schemaVersion: 1,
    transferId: manifest.transferId,
    key: structuredClone(manifest.key),
    manifestDigest,
    accepted,
    receipt: createHash("sha256").update(`${accepted}\0${manifestDigest}`).digest("hex"),
  };
}
export function validateReceipt(value: unknown, manifest: UploadManifest): UploadReceipt {
  exact(value, ["schemaVersion", "transferId", "key", "manifestDigest", "accepted", "receipt"]);
  if (
    value.schemaVersion !== 1 ||
    value.transferId !== manifest.transferId ||
    value.manifestDigest !== uploadDigest(manifest) ||
    typeof value.accepted !== "boolean" ||
    value.receipt !== createReceipt(manifest, value.accepted).receipt ||
    fingerprintConfig(value.key as JsonValue) !== fingerprintConfig(manifest.key)
  )
    throw new TransferError("TRANSFER_PROTOCOL_INVALID", "Receipt does not match uploaded attempt");
  return value as UploadReceipt;
}
