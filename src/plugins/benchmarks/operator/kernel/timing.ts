import { createHash } from "node:crypto";
import { associateKernelSteps } from "./timing-flow.js";
import { expectRecord, expectNonEmptyString } from "../../../../core/validation/input.js";

export type KernelTimingRow = { step: number; device: string; stream: string; name: string; startUs: number; durationUs: number };
export type KernelTimingSample = { csvPath: string; csvSha256: string; tracePath: string; traceSha256: string; warmup: number; repeat: number; meanMs: number; rows: KernelTimingRow[] };
export type KernelTimingEvidence = { schemaVersion: 2; method: "profiler-flow/v1"; reference: KernelTimingSample; candidate: KernelTimingSample };

function finite(value: unknown, name: string, positive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new TypeError(`Invalid timing ${name}`);
  return value;
}
function count(value: unknown, name: string): number {
  const n = finite(value, name, true);
  if (!Number.isSafeInteger(n)) throw new TypeError(`Invalid timing ${name}`);
  return n;
}
function sample(value: unknown): KernelTimingSample {
  const r = expectRecord(value, "timing sample");
  const path = (key: string): string => {
    const value = expectNonEmptyString(r[key], `timing.${key}`);
    if (value.startsWith("/") || /[\\:\x00]/u.test(value) || value.split("/").some(p => p === ".." || p === "." || !p)) throw new TypeError("Unsafe timing evidence path");
    return value;
  };
  const hash = (key: string): string => {
    const value = expectNonEmptyString(r[key], `timing.${key}`);
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError("Invalid timing evidence digest");
    return value;
  };
  const csvPath = path("csvPath"), tracePath = path("tracePath"), csvSha256 = hash("csvSha256"), traceSha256 = hash("traceSha256");
  if (csvPath === tracePath || !csvPath.endsWith("/kernel_details.csv") || !tracePath.endsWith("/trace_view.json")) throw new TypeError("Invalid timing evidence files");
  const warmup = count(r.warmup, "warmup"), repeat = count(r.repeat, "repeat");
  if (!Array.isArray(r.rows) || !r.rows.length) throw new TypeError("Missing timing rows");
  const seen = new Set<string>();
  const rows = r.rows.map(value => {
    const v = expectRecord(value, "timing row");
    const step = finite(v.step, "step");
    if (!Number.isSafeInteger(step) || step >= warmup + repeat) throw new TypeError("Invalid timing step");
    const row: KernelTimingRow = {step, device: expectNonEmptyString(v.device,"timing.device"), stream: expectNonEmptyString(v.stream,"timing.stream"),
      name: expectNonEmptyString(v.name,"timing.name"), startUs: finite(v.startUs,"startUs"), durationUs: finite(v.durationUs,"durationUs")};
    const key = JSON.stringify(row);
    if (seen.has(key)) throw new TypeError("Duplicate timing record");
    seen.add(key);
    return row;
  });
  if (new Set(rows.map(row => row.step)).size !== warmup + repeat || new Set(rows.map(row => row.device)).size !== 1) throw new TypeError("Incomplete timing steps or mixed devices");
  const chronological = [...rows].sort((a,b) => a.startUs - b.startUs);
  if (chronological.some((row,i) => i > 0 && row.step < chronological[i-1]!.step)) throw new TypeError("Timing step order mismatch");
  const meanMs = finite(r.meanMs,"meanMs",true);
  const recomputed = rows.reduce((sum,row) => sum + (row.step >= warmup ? row.durationUs : 0),0) / repeat / 1000;
  if (!Number.isFinite(recomputed) || Math.abs(meanMs-recomputed) > Math.max(1e-12, Math.abs(recomputed)*1e-9)) throw new TypeError("Timing mean does not match rows");
  return {csvPath,csvSha256,tracePath,traceSha256,warmup,repeat,meanMs,rows};
}
export function parseKernelTimingEvidence(value: unknown): KernelTimingEvidence {
  const r = expectRecord(value,"kernel timing evidence");
  if (r.schemaVersion !== 2 || r.method !== "profiler-flow/v1") throw new TypeError("Unsupported kernel timing evidence");
  const reference = sample(r.reference), candidate = sample(r.candidate);
  if (reference.warmup !== candidate.warmup || reference.repeat !== candidate.repeat) throw new TypeError("Different timing protocols");
  if (!reference.csvPath.startsWith("profile-reference/") || !candidate.csvPath.startsWith("profile-candidate/") || !reference.tracePath.startsWith("profile-reference/") || !candidate.tracePath.startsWith("profile-candidate/") ||
      reference.rows[0]!.device !== candidate.rows[0]!.device) throw new TypeError("Timing profiles must be distinct and use the same device");
  return {schemaVersion:2,method:"profiler-flow/v1",reference,candidate};
}

// Only used at the raw profiler-file boundary. Handles quoted CSV fields and CRLF.
function csvRecords(text: string): string[][] {
  const records: string[][] = []; let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i+1] === '"') {field += '"'; i++;} else {quoted = false; closed = true;} }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === "," || c === "\n" || c === "\r") {
      row.push(field); field = ""; closed = false;
      if (c !== ",") { if (c === "\r" && text[i+1] === "\n") i++; records.push(row); row = []; }
    } else { if (closed || c === '"') throw new TypeError("Malformed timing CSV"); field += c; }
  }
  if (quoted) throw new TypeError("Unclosed timing CSV field");
  if (field || row.length || closed) {row.push(field); records.push(row);}
  return records;
}
export function auditKernelTimingSample(evidence: KernelTimingSample, csv: string | Uint8Array, trace: string | Uint8Array): void {
  const buffer = typeof csv === "string" ? Buffer.from(csv) : Buffer.from(csv);
  const traceBuffer = typeof trace === "string" ? Buffer.from(trace) : Buffer.from(trace);
  if (createHash("sha256").update(buffer).digest("hex") !== evidence.csvSha256) throw new TypeError("Timing CSV digest mismatch");
  if (createHash("sha256").update(traceBuffer).digest("hex") !== evidence.traceSha256) throw new TypeError("Timing trace digest mismatch");
  const [header,...records] = csvRecords(buffer.toString("utf8").replace(/^\uFEFF/u,""));
  if (!header || new Set(header).size !== header.length) throw new TypeError("Invalid timing CSV header");
  const fields = ["Device_id","Stream ID","Name","Start Time(us)","Duration(us)"];
  if (fields.some(f => !header.includes(f))) throw new TypeError("Missing timing CSV fields");
  const raw = records.map(record => {
    if (record.length !== header.length) throw new TypeError("Invalid timing CSV row");
    const get = (name: string): string => record[header.indexOf(name)]!.trim();
    if (fields.some(f => !get(f))) throw new TypeError("Empty timing CSV field");
    return {device:get("Device_id"),stream:get("Stream ID"),name:get("Name"),start:get("Start Time(us)"),duration:get("Duration(us)"),
      ...(header.includes("Task ID") ? {task:get("Task ID")} : {})};
  });
  const rows = associateKernelSteps(raw, traceBuffer.toString("utf8"), evidence.warmup + evidence.repeat);
  const checked = sample({...evidence,rows});
  if (JSON.stringify(checked.rows) !== JSON.stringify(evidence.rows)) throw new TypeError("Timing flow records differ from evidence");
}
