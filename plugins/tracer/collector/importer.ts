/** Import offline result directories or uploaded files into the store. */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { EVENT_STEP_SEQ, EVENT_TYPES, broadcast, handleDoc } from "./ingest.js";
import { RT } from "./runtime.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const STATIC_NAMES = new Set(["agentx-summary.json", "trajectory.jsonl", "trajectory.json"]);
const MAX_FILES = 5000;

type Entry = [string, string];
type Obj = Record<string, unknown>;

export interface ImportResult {
  epoch: string;
  epochs: string[];
  summary: number;
  trajectory: number;
  skipped: number;
  errors: number;
}

function parts(rel: string): string[] {
  return rel.split(/[\\/]/).filter(part => part.length > 0);
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

/** Use attempts/<attemptId> as session id when the path exposes one. */
function staticAttempt(rel: string): string {
  const segments = parts(rel);
  const index = segments.lastIndexOf("attempts");
  if (index >= 0 && index + 1 < segments.length) return segments[index + 1]!;
  const parent = dirname(rel);
  return parent === "." ? "static" : basename(parent) || "static";
}

/** Prefer the picked run directory, then the first uuid in the relative path. */
function staticEpoch(rel: string, fallback: string): string {
  if (UUID_RE.test(fallback || "")) return fallback;
  for (const part of parts(rel)) {
    if (UUID_RE.test(part)) return part;
  }
  return fallback || "static";
}

/** Without a directory, derive a stable session from the workload. */
function summarySession(rel: string, data: unknown): string {
  if (parts(rel).length > 1) return staticAttempt(rel);
  const workload = asObject(asObject(data).workload);
  const bits = [String(workload.mode ?? ""), String(workload.variant ?? "")];
  if (workload.concurrency !== null && workload.concurrency !== undefined) bits.push(`c${String(workload.concurrency)}`);
  return bits.filter(bit => bit).join("-") || basename(rel).replace(/\.[^.]+$/, "");
}

/** Recover runIds from trajectory events when file paths carry no epoch. */
function entryRunIds(entries: Entry[]): string[] {
  const ids: string[] = [];
  for (const [rel, text] of entries) {
    if (basename(rel) !== "trajectory.jsonl") continue;
    for (const line of text.split(/\r?\n/)) {
      let key: unknown;
      try {
        key = asObject(JSON.parse(line) as unknown).key;
      } catch {
        continue;
      }
      const runId = asObject(key).runId;
      if (runId && !ids.includes(String(runId))) ids.push(String(runId));
    }
  }
  return ids;
}

/** Import (relative path, text) pairs, dispatching by file name. */
export async function importStatic(entries: Entry[], fixedEpoch: string, fallbackEpoch: string): Promise<ImportResult> {
  const counts = { summary: 0, trajectory: 0, skipped: 0, errors: 0 };
  const epochs: string[] = [];
  // Uploaded files carry no epoch; a single shared runId becomes the default.
  const runIds = entryRunIds(entries);
  const defaultEpoch = fixedEpoch || (runIds.length === 1 ? runIds[0]! : fallbackEpoch);

  const epochOf = (rel: string): string => {
    const epoch = fixedEpoch || staticEpoch(rel, defaultEpoch);
    if (!epochs.includes(epoch)) epochs.push(epoch);
    return epoch;
  };

  for (const [rel, text] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))) {
    const name = basename(rel);
    if (name === "agentx-summary.json") {
      const epoch = epochOf(rel);
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        counts.errors += 1;
        continue;
      }
      const event = await handleDoc(null, { session: summarySession(rel, data), epoch, seq: 1, data });
      if (event === null) {
        counts.skipped += 1;
      } else {
        counts.summary += 1;
        broadcast(event);
      }
    } else if (name === "trajectory.jsonl") {
      const epoch = epochOf(rel);
      const attempt = staticAttempt(rel);
      // Skip a file already rebuilt from events to avoid double-counting steps.
      if (parts(rel).length > 1 && RT.store !== null && RT.store.listEvents(epoch, attempt).length > 0) {
        counts.skipped += 1;
        continue;
      }
      let accepted = 0;
      let skipped = 0;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          counts.errors += 1;
          continue;
        }
        const record = asObject(parsed);
        if (Object.keys(record).length === 0 || typeof record.type !== "string" || !EVENT_TYPES.has(record.type)) {
          skipped += 1;
          continue;
        }
        const key = asObject(record.key);
        const lineEpoch = fixedEpoch || String(key.runId ?? epoch);
        const lineAttempt = String(key.attemptId ?? attempt);
        if (!epochs.includes(lineEpoch)) epochs.push(lineEpoch);
        record.epoch = lineEpoch;
        const event = await handleDoc(lineAttempt, record);
        if (event === null) {
          skipped += 1;
        } else {
          accepted += 1;
          broadcast(event);
        }
      }
      counts.trajectory += accepted;
      counts.skipped += skipped;
    } else if (name === "trajectory.json") {
      const epoch = epochOf(rel);
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        counts.errors += 1;
        continue;
      }
      const record = asObject(data);
      if (!Array.isArray(record.steps)) {
        counts.skipped += 1;
        continue;
      }
      const event = await handleDoc(null, { session: staticAttempt(rel), epoch, seq: EVENT_STEP_SEQ, data });
      if (event === null) {
        counts.skipped += 1;
      } else {
        counts.trajectory += 1;
        broadcast(event);
      }
    }
  }

  // Imported snapshots never emit a finish event; mark them finished so
  // background analysis is not blocked forever.
  if (RT.store !== null) {
    const db = RT.store;
    for (const epoch of epochs) {
      const run = db.getRun(epoch) ?? {};
      if (String(run.status ?? "").toLowerCase() !== "finished") db.finishRun(epoch);
    }
  }

  return {
    epoch: epochs.length > 0 ? epochs[0]! : fixedEpoch || fallbackEpoch,
    epochs,
    ...counts,
  };
}

/** Read every recognized artifact under a directory. */
export function collectDirEntries(root: string): Entry[] {
  const entries: Entry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && STATIC_NAMES.has(entry.name)) {
        try {
          entries.push([relative(root, path).split(sep).join("/"), readFileSync(path, "utf8")]);
        } catch {
          // Skip unreadable artifacts.
        }
      }
    }
  };
  walk(root);
  return entries;
}

/** Normalize the JSON upload payload into (relative path, text) entries. */
export function parseFilesPayload(files: unknown): Entry[] {
  if (!Array.isArray(files)) return [];
  const entries: Entry[] = [];
  for (const item of files.slice(0, MAX_FILES)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Obj;
    const rel = String(record.path ?? "").trim();
    const text = record.text;
    if (rel && typeof text === "string" && STATIC_NAMES.has(basename(rel))) entries.push([rel, text]);
  }
  return entries;
}
