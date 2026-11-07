/** Spool buffering and ingestion of traces, events and task outcomes. */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { outcomeFromResult, stepsFromEvents } from "./evaluator-events.js";
import { round } from "./num.js";
import { BoundedDeque, RT } from "./runtime.js";

export const KNOWN_KINDS = new Set(["trajectory", "outcome", "summary"]);
// External producers may label a summary differently (AgentX writes kind=agentx).
const KIND_ALIASES: Record<string, string> = { agentx: "summary" };
const KNOWN_FORMAT_PREFIXES = ["atif", "agentx"];

export const EVENT_TYPES = new Set([
  "start",
  "message_start",
  "message",
  "tool_start",
  "tool_result",
  "agent_end",
  "usage",
  "end",
  "error",
]);
const EVENT_TERMINAL_TYPES = new Set(["end", "error"]);
// A rebuilt attempt is stored as a single row, so a fixed seq lets rebuilds overwrite it.
export const EVENT_STEP_SEQ = 0;
// Rebuild while a run is still streaming at most once per interval; terminal
// events bypass the throttle so the final state always lands in the database.
const MATERIALIZE_INTERVAL_S = 1.0;
// Values below are "not finished yet" for the purpose of background analysis.
export const RUNNING_STATUSES = new Set(["running", "started", "in_progress", "pending"]);

type Obj = Record<string, unknown>;

const lastMaterialize = new Map<string, number>();
const pendingMaterialize = new Map<string, ReturnType<typeof setTimeout>>();

function keyOf(epoch: string, attempt: string): string {
  return `${epoch}\u0000${attempt}`;
}

function monotonic(): number {
  return performance.now() / 1000;
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function asObject(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

export function inferSession(obj: unknown): string | null {
  const record = asObject(obj);
  if (Object.keys(record).length === 0) return null;
  const key = asObject(record.key);
  for (const name of ["session_id", "sessionId", "trajectory_id", "trajectoryId"]) {
    if (truthy(record[name])) return String(record[name]);
  }
  for (const name of ["session_id", "attemptId", "taskId", "runId"]) {
    if (truthy(key[name])) return String(key[name]);
  }
  return null;
}

export function spoolDir(): string {
  mkdirSync(RT.cfg.spool, { recursive: true });
  return RT.cfg.spool;
}

export async function spoolWrite(session: string | null, lines: string[]): Promise<string> {
  const name = `${Date.now()}-${randomUUID().replaceAll("-", "")}.ndjson`;
  const tmp = join(spoolDir(), `${name}.tmp`);
  const final = join(spoolDir(), name);
  const body = [`${JSON.stringify({ __spool_header__: true, session })}\n`];
  for (const line of lines) body.push(`${line.replace(/\n+$/, "")}\n`);
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(body.join(""), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, final);
  return final;
}

export function spoolRead(path: string): { session: string | null; docs: string[] } {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const first = lines.shift() ?? "";
  const docs: string[] = [];
  let session: string | null = null;
  let header = false;
  try {
    const parsed = JSON.parse(first) as unknown;
    const record = asObject(parsed);
    if (truthy(record.__spool_header__)) {
      header = true;
      session = record.session === null || record.session === undefined ? null : String(record.session);
    }
  } catch {
    header = false;
  }
  if (header) {
    for (const line of lines) if (line.trim()) docs.push(line);
    return { session, docs };
  }
  if (first.trim()) docs.push(first);
  for (const line of lines) if (line.trim()) docs.push(line);
  return { session: null, docs };
}

export function deadLetter(line: string, reason: string): void {
  try {
    appendFileSync(
      join(spoolDir(), "dead-letter.ndjson"),
      `${JSON.stringify({ at: Date.now() / 1000, reason, line })}\n`,
      "utf8",
    );
    RT.st.metrics.dead_letter_lines += 1;
  } catch {
    // Dead letters are best effort.
  }
}

function formatOk(format: unknown): boolean {
  const text = String(format).toLowerCase();
  return KNOWN_FORMAT_PREFIXES.some(prefix => text.startsWith(prefix));
}

export function enqueue(path: string): boolean {
  if (RT.st.queued.has(path)) return false;
  if (!RT.st.queue.push(path)) return false;
  RT.st.queued.add(path);
  return true;
}

function guessKind(obj: unknown): string {
  const record = asObject(obj);
  if (Object.keys(record).length === 0) return "unknown";
  if (record.kind === "outcome" || ("success" in record && ("task_id" in record || "taskId" in record))) {
    return "outcome";
  }
  const schemaVersion = String(record.schema_version ?? record.schemaVersion ?? "");
  if (schemaVersion.startsWith("ATIF") || truthy(record.steps) || truthy(record.subagent_trajectories)) {
    return "trajectory";
  }
  if (
    record.kind === "agentx" ||
    truthy(record.profiling) ||
    truthy(record.profiling_metrics) ||
    truthy(record.telemetry) ||
    truthy(record.metrics_phase)
  ) {
    return "summary";
  }
  return "unknown";
}

function trajectoryStats(data: unknown): Obj | null {
  const record = asObject(data);
  const steps = record.steps;
  if (!Array.isArray(steps)) return null;
  let errors = 0;
  let tokens = 0;
  const starts: number[] = [];
  const ends: number[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    const item = step as Obj;
    const invocation = asObject(asObject(item.extra).invocation);
    const status = String(invocation.status ?? item.status ?? "").toLowerCase();
    if (status === "error" || status === "failed" || status === "failure" || status === "timeout") errors += 1;
    const metrics = asObject(item.metrics);
    for (const name of ["prompt_tokens", "completion_tokens"]) {
      const value = metrics[name];
      if (typeof value === "number") tokens += Math.trunc(value);
    }
    const start = invocation.start_timestamp;
    const end = invocation.end_timestamp;
    if (typeof start === "number") starts.push(start);
    if (typeof end === "number") ends.push(end);
  }
  let durationMs: number | null = null;
  if (starts.length > 0 && ends.length > 0) {
    durationMs = Math.max(0, (Math.max(...ends) - Math.min(...starts)) * 1000);
  }
  return {
    steps: steps.length,
    errors,
    tokens,
    duration_ms: durationMs === null ? null : round(durationMs, 3),
  };
}

function store(sess: string, kind: string, seq: number | null, data: unknown, ctx: Obj = {}, eventId: string | null = null): void {
  try {
    persist(sess, kind, seq, data, ctx, eventId);
  } catch (error) {
    RT.st.metrics.db_errors += 1;
    throw error;
  }
}

function persist(sess: string, kind: string, seq: number | null, data: unknown, ctx: Obj = {}, eventId: string | null = null): void {
  if (kind === "outcome") {
    const storeRef = RT.store;
    if (storeRef !== null && storeRef !== undefined) {
      const epoch = String(ctx.epoch ?? `adhoc:${sess || "default"}`);
      if (truthy(ctx.candidate_id) || truthy(ctx.parent_id)) {
        storeRef.upsertRun(epoch, ctx.candidate_id as string | null, ctx.parent_id as string | null);
      }
      storeRef.addOutcome(epoch, asObject(data));
    }
    return;
  }
  const epoch = String(ctx.epoch ?? "adhoc");
  const storeRef = RT.store;
  if (storeRef !== null && (truthy(ctx.candidate_id) || truthy(ctx.parent_id))) {
    storeRef.upsertRun(epoch, ctx.candidate_id as string | null, ctx.parent_id as string | null);
  }
  const stats = kind === "trajectory" ? trajectoryStats(data) : null;
  const now = Date.now() / 1000;
  let session = RT.st.sessions.get(sess);
  if (session === undefined) {
    session = {
      id: sess,
      kind: kind || "unknown",
      count: 0,
      firstAt: now,
      updatedAt: now,
      epoch,
      stats: null,
      batches: new BoundedDeque(RT.cfg.maxBatches),
    };
    RT.st.sessions.set(sess, session);
  }
  if (kind && kind !== "unknown" && (session.kind === "unknown" || kind === "trajectory")) session.kind = kind;
  session.count += 1;
  session.updatedAt = now;
  session.epoch = epoch;
  if (stats !== null) session.stats = stats;
  session.batches.push({ seq, kind, data, at: now });
  if (storeRef !== null && storeRef !== undefined) {
    const inserted = storeRef.addTrace(epoch, sess, seq, kind, data, eventId);
    if (inserted) storeRef.touchSession(epoch, sess, kind, stats);
  }
}

export function broadcast(event: unknown): void {
  for (const subscriber of [...RT.st.subscribers]) {
    if (!subscriber.push(event)) RT.st.metrics.sse_dropped += 1;
  }
  RT.st.metrics.broadcasts += 1;
}

/** True for a single line of an Evaluator trajectory.jsonl. */
function isEventRow(obj: unknown): boolean {
  const record = asObject(obj);
  const key = record.key;
  return (
    key !== null &&
    typeof key === "object" &&
    !Array.isArray(key) &&
    typeof record.type === "string" &&
    (truthy((key as Obj).runId) || truthy((key as Obj).attemptId))
  );
}

/** True for an Evaluator result.json document. */
function isResultRow(obj: unknown): boolean {
  const record = asObject(obj);
  const key = record.key;
  return (
    key !== null &&
    typeof key === "object" &&
    !Array.isArray(key) &&
    truthy((key as Obj).taskId) &&
    ("executionStatus" in record || "verdict" in record)
  );
}

/** Store result.json as an outcome keyed by runId. */
function handleResult(obj: Obj): Obj | null {
  if (RT.store === null) return null;
  const db = RT.store;
  const outcome = outcomeFromResult(obj);
  if (outcome === null || !outcome.task_id) {
    RT.st.metrics.bad_lines += 1;
    deadLetter(JSON.stringify(obj), "outcome without task_id");
    return null;
  }
  const epoch = String(obj.epoch ?? outcome.run_id ?? "adhoc");
  db.addOutcome(epoch, outcome);
  RT.st.metrics.outcomes_accepted += 1;
  // A result forces one rebuild so traces missing an end event get their final shape.
  const attempt = String(outcome.attempt_id ?? "");
  if (!attempt) return null;
  cancelMaterialize(epoch, attempt);
  lastMaterialize.set(keyOf(epoch, attempt), monotonic());
  const payload = materializeAttempt(epoch, attempt);
  return {
    session: attempt,
    kind: "trajectory",
    seq: EVENT_STEP_SEQ,
    epoch,
    at: Date.now() / 1000,
    text: JSON.stringify(payload),
  };
}

/** Rebuild stored events into an ATIF-style trajectory row. */
export function materializeAttempt(epoch: string, attempt: string): Obj {
  const db = RT.db;
  const payload = stepsFromEvents(db.listEvents(epoch, attempt));
  const stats = trajectoryStats(payload);
  const created = db.putTrace(epoch, attempt, EVENT_STEP_SEQ, "trajectory", payload);
  db.touchSession(epoch, attempt, "trajectory", stats, created);
  return payload;
}

function allowMaterialize(epoch: string, attempt: string): boolean {
  const last = lastMaterialize.get(keyOf(epoch, attempt));
  return last === undefined || monotonic() - last >= MATERIALIZE_INTERVAL_S;
}

/** Rebuild once the throttle window ends, so the last event of a burst is not lost. */
function scheduleMaterialize(epoch: string, attempt: string): void {
  const key = keyOf(epoch, attempt);
  if (pendingMaterialize.has(key)) return;
  const delay = Math.max(0, MATERIALIZE_INTERVAL_S - (monotonic() - (lastMaterialize.get(key) ?? 0)));
  const timer = setTimeout(() => {
    pendingMaterialize.delete(key);
    try {
      lastMaterialize.set(key, monotonic());
      const payload = materializeAttempt(epoch, attempt);
      broadcast({
        session: attempt,
        kind: "trajectory",
        seq: EVENT_STEP_SEQ,
        epoch,
        at: Date.now() / 1000,
        text: JSON.stringify(payload),
      });
    } catch {
      RT.st.metrics.processing_errors += 1;
    }
  }, delay * 1000);
  timer.unref();
  pendingMaterialize.set(key, timer);
}

function cancelMaterialize(epoch: string, attempt: string): void {
  const key = keyOf(epoch, attempt);
  const timer = pendingMaterialize.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingMaterialize.delete(key);
  }
}

/** Persist one trajectory event and rebuild the attempt when allowed. */
function handleEvent(obj: Obj): Obj | null {
  const eventType = String(obj.type);
  if (!EVENT_TYPES.has(eventType)) {
    RT.st.metrics.unknown_event_lines += 1;
    deadLetter(JSON.stringify(obj), `unknown event type ${JSON.stringify(eventType)}`);
    return null;
  }
  const key = asObject(obj.key);
  // One epoch per run, one trajectory per attempt.
  const epoch = String(obj.epoch ?? key.runId ?? "adhoc");
  const attempt = String(key.attemptId ?? inferSession(obj) ?? "default");
  if (!RT.db.addEvent(epoch, attempt, typeof obj.seq === "number" ? obj.seq : null, eventType, typeof obj.at === "string" ? obj.at : null, obj)) {
    RT.st.metrics.deduped += 1;
    return null;
  }
  RT.st.metrics.events_accepted += 1;
  if (!EVENT_TERMINAL_TYPES.has(eventType) && !allowMaterialize(epoch, attempt)) {
    scheduleMaterialize(epoch, attempt);
    return null;
  }
  cancelMaterialize(epoch, attempt);
  lastMaterialize.set(keyOf(epoch, attempt), monotonic());
  const payload = materializeAttempt(epoch, attempt);
  return {
    session: attempt,
    kind: "trajectory",
    seq: EVENT_STEP_SEQ,
    epoch,
    at: Date.now() / 1000,
    text: JSON.stringify(payload),
  };
}

export async function handleDoc(sessionHint: string | null, doc: unknown): Promise<Obj | null> {
  const obj = asObject(doc);
  let explicitKind: string | null = null;
  if (typeof obj.kind === "string") explicitKind = KIND_ALIASES[obj.kind] ?? obj.kind;
  const format = obj.format;
  if (explicitKind && !KNOWN_KINDS.has(explicitKind)) {
    RT.st.metrics.unknown_kind_lines += 1;
    deadLetter(JSON.stringify(obj), `unknown kind ${JSON.stringify(explicitKind)}`);
    return null;
  }
  if (truthy(format) && !formatOk(format)) {
    RT.st.metrics.unknown_format_lines += 1;
    deadLetter(JSON.stringify(obj), `unknown format ${JSON.stringify(format)}`);
    return null;
  }
  if (isResultRow(obj)) return handleResult(obj);
  if (isEventRow(obj)) return handleEvent(obj);

  let session: string;
  let seq: number | null;
  let data: unknown;
  let eventId: string | null = null;
  let ctx: Obj = {};
  let kind: string;
  if ("data" in obj && ("session" in obj || "seq" in obj)) {
    session = sessionHint || String(obj.session ?? "default");
    seq = typeof obj.seq === "number" ? obj.seq : null;
    data = obj.data;
    eventId = typeof obj.event_id === "string" ? obj.event_id : null;
    ctx = {
      epoch: obj.epoch,
      candidate_id: obj.candidate_id,
      parent_id: obj.parent_id,
      task_id: obj.task_id,
    };
    kind = explicitKind ?? guessKind(data);
  } else {
    session = sessionHint || inferSession(obj) || "default";
    seq = null;
    data = obj;
    eventId = typeof obj.event_id === "string" ? obj.event_id : null;
    ctx = {
      epoch: obj.epoch,
      candidate_id: obj.candidate_id,
      parent_id: obj.parent_id,
      task_id: obj.task_id,
    };
    kind = explicitKind ?? guessKind(obj);
  }
  const dedupe = eventId ? `e:${eventId}` : seq !== null ? `s:${seq}` : null;
  if (dedupe !== null) {
    let seen = RT.st.seen.get(session);
    if (seen === undefined) {
      seen = new Set<string>();
      RT.st.seen.set(session, seen);
    }
    if (seen.has(dedupe)) {
      RT.st.metrics.deduped += 1;
      return null;
    }
    seen.add(dedupe);
    if (seen.size > RT.cfg.maxSeen) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
  }
  if (kind === "trajectory" && RT.cfg.sampleRate < 1 && Math.random() > RT.cfg.sampleRate) {
    RT.st.metrics.sampled_drop += 1;
    return null;
  }
  store(session, kind, seq, data, ctx, eventId);
  RT.st.metrics.accepted += 1;
  if (kind === "outcome") return null;
  return {
    session,
    kind,
    seq,
    epoch: ctx.epoch ?? null,
    at: Date.now() / 1000,
    text: JSON.stringify(data),
  };
}

export async function consumer(): Promise<void> {
  while (true) {
    const path = await RT.st.queue.shift();
    if (path === undefined) return;
    let done = false;
    try {
      const { session, docs } = spoolRead(path);
      for (const line of docs) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          RT.st.metrics.bad_lines += 1;
          deadLetter(line, "bad json");
          continue;
        }
        let event: Obj | null;
        try {
          event = await handleDoc(session, parsed);
        } catch {
          RT.st.metrics.processing_errors += 1;
          deadLetter(line, "processing error");
          continue;
        }
        if (event !== null) broadcast(event);
      }
      done = true;
    } catch {
      RT.st.metrics.processing_errors += 1;
      try {
        await rename(path, `${path}.failed`);
        done = true;
      } catch {
        done = false;
      }
    } finally {
      RT.st.queued.delete(path);
      if (done) {
        try {
          await unlink(path);
        } catch {
          // Already removed.
        }
      }
    }
  }
}

export async function spoolSweeper(): Promise<void> {
  while (!RT.st.stopping) {
    await sleep(2000);
    if (RT.st.stopping) return;
    try {
      if (RT.st.queue.size >= Math.max(1, Math.floor(RT.cfg.maxQueue / 2))) continue;
      const names = (await readdir(spoolDir())).filter(name => name.endsWith(".ndjson")).sort();
      for (const name of names) {
        if (name === "dead-letter.ndjson") continue;
        if (!enqueue(join(spoolDir(), name))) break;
      }
    } catch {
      // The spool directory may be unavailable; retry on the next sweep.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms).unref();
  });
}

export function dropLocalEpochs(epochs: string[]): void {
  for (const epoch of epochs) {
    for (const [sessionId, session] of [...RT.st.sessions]) {
      if (session.epoch === epoch) {
        RT.st.sessions.delete(sessionId);
        RT.st.seen.delete(sessionId);
      }
    }
  }
}

/** Drop epochs whose last activity is older than the retention window. */
export function purgeRetention(): string[] {
  if (RT.store === null) return [];
  if (!RT.cfg.retentionDays || RT.cfg.retentionDays <= 0) return [];
  const cutoff = Date.now() / 1000 - RT.cfg.retentionDays * 86400;
  const purged = RT.store.purgeOlderThan(cutoff);
  RT.st.metrics.retention_purged_epochs += purged.length;
  dropLocalEpochs(purged);
  return purged;
}

export async function retentionSweeper(): Promise<void> {
  while (!RT.st.stopping) {
    await sleep(RT.cfg.retentionInterval * 1000);
    if (RT.st.stopping) return;
    try {
      purgeRetention();
    } catch {
      // Retention is best effort.
    }
  }
}
