import { readFile } from "node:fs/promises";
import { checkedPath } from "../../core/artifacts/artifacts.js";

export type ReportRecovery = {
  schemaVersion: 1;
  status: "detected";
  reason: "mixed-snapshots" | "incomplete-publication" | "invalid-metadata" | "mixed-revisions";
  metricsDigest: string | null;
  reportDigest: string | null;
  targetDigest: string;
  detectedAt: string;
};

async function optionalText(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(await checkedPath(root, path), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Read the previous pair before rebuilding, preserving evidence of interrupted publication. */
export async function inspectReportPair(root: string, targetDigest: string): Promise<ReportRecovery | null> {
  const [metrics, report] = await Promise.all([optionalText(root, "metrics.json"), optionalText(root, "report.md")]);
  if (metrics === null && report === null) return null;
  let metricsDigest: string | null = null;
  let metricsRevision: unknown;
  try {
    const value = JSON.parse(metrics ?? "null") as { snapshotDigest?: unknown; revision?: unknown } | null;
    metricsRevision = value?.revision;
    if (typeof value?.snapshotDigest === "string" && /^[a-f0-9]{64}$/.test(value.snapshotDigest))
      metricsDigest = value.snapshotDigest;
  } catch {
    /* A malformed envelope must be diagnosed and rebuilt from committed results. */
  }
  const reportDigest = report?.match(/^<!-- snapshotDigest: ([a-f0-9]{64}) -->\n/)?.[1] ?? null;
  const reportRevision = report?.match(/^<!-- revision: ([1-9]\d*) -->$/mu)?.[1];
  const matchingRevision = metricsRevision === undefined && reportRevision === undefined || Number.isSafeInteger(metricsRevision) && Number(reportRevision) === metricsRevision;
  if (metricsDigest !== null && metricsDigest === reportDigest && matchingRevision) return null;
  return {
    schemaVersion: 1,
    status: "detected",
    targetDigest,
    metricsDigest,
    reportDigest,
    reason:
      metrics === null || report === null
        ? "incomplete-publication"
        : metricsDigest === null || reportDigest === null
          ? "invalid-metadata"
          : metricsDigest !== reportDigest ? "mixed-snapshots" : "mixed-revisions",
    detectedAt: new Date().toISOString(),
  };
}
