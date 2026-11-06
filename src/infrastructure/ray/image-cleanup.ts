import type { ImageCleanupSummary, ImageCleanupRequest } from "../../core/contracts/image-cleanup.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";

export function parseImageCleanupRequest(value: unknown): ImageCleanupRequest {
  const record = expectRecord(value, "image cleanup request");
  rejectUnknown(record, ["all", "execute", "configFingerprint"], "image cleanup request");
  if (typeof record.all !== "boolean" || typeof record.execute !== "boolean" ||
    record.configFingerprint !== undefined && (typeof record.configFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(record.configFingerprint)) ||
    !record.all && !record.configFingerprint) throw new TypeError("Invalid image cleanup request");
  return { all: record.all, execute: record.execute, ...(typeof record.configFingerprint === "string" ? { configFingerprint: record.configFingerprint } : {}) };
}
export function parseImageCleanupSummary(value: unknown): ImageCleanupSummary {
  const result = expectRecord(value, "image cleanup summary");
  if (typeof result.preview !== "boolean" || !Array.isArray(result.nodes)) throw new TypeError("Invalid image cleanup summary");
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
  const seen = new Set<string>();
  for (const raw of result.nodes) {
    const node = expectRecord(raw, "image cleanup node");
    if (!text(node.nodeId) || typeof node.daemonId !== "string" || node.inventoryId !== undefined && !text(node.inventoryId) || !Array.isArray(node.items) || node.error !== undefined && !text(node.error)) throw new TypeError("Invalid image cleanup node");
    if (seen.has(node.nodeId) || !node.error && !text(node.daemonId)) throw new TypeError("Duplicate or unidentified image cleanup node");
    seen.add(node.nodeId);
    for (const rawItem of node.items) {
      const item = expectRecord(rawItem, "image cleanup item");
      if (!text(item.reference) || typeof item.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.imageId) || !text(item.reason) ||
        !["candidate", "deleted", "retained", "skipped", "failed"].includes(String(item.status)) || result.preview && item.status === "deleted") throw new TypeError("Invalid image cleanup item");
    }
  }
  return result as ImageCleanupSummary;
}
