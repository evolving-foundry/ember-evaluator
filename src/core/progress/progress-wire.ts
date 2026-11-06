import { randomUUID } from "node:crypto";
import type { ProgressEvent, ProgressListener, LiveProgress } from "./progress.js";
import { LIVE_BUDGET, LIVE_LINES, ProgressSnapshots, safeProgress } from "./live-progress.js";

export type ProgressSnapshot = { schemaVersion: 1; publisherId: string; sequence: number; events: ProgressEvent[]; ended?: boolean; ageMs?: number };
const statuses: LiveProgress["status"][] = ["started", "updated", "completed", "failed", "cancelled"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid progress object");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 2048): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError("Invalid progress string");
}
function number(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError("Invalid progress number");
}
export function parseProgressSnapshot(input: unknown): ProgressSnapshot {
  const root = object(input);
  if (root.schemaVersion !== 1) throw new TypeError("Invalid progress version");
  text(root.publisherId, 128); number(root.sequence);
  if (!Number.isSafeInteger(root.sequence) || root.sequence < 1 || !Array.isArray(root.events) || root.events.length > 4097 ||
    Buffer.byteLength(JSON.stringify(input)) > LIVE_BUDGET) throw new TypeError("Invalid progress size or sequence");
  if (root.ended !== undefined && typeof root.ended !== "boolean") throw new TypeError("Invalid progress ended flag");
  if (root.ageMs !== undefined) number(root.ageMs);
  const events = root.events.map((input: unknown): ProgressEvent => {
    const item = object(input);
    text(item.phase, 128); text(item.message);
    const event: ProgressEvent = { phase: item.phase, message: item.message, transient: true };
    for (const field of ["taskId", "attemptId"] as const) if (item[field] !== undefined) { text(item[field]); event[field] = item[field]; }
    for (const field of ["taskNumber", "taskTotal"] as const) if (item[field] !== undefined) { number(item[field]); event[field] = item[field]; }
    if (item.live !== undefined) {
      const live = object(item.live);
      text(live.id); number(live.sequence); number(live.elapsedMs); number(live.idleMs);
      if (!Number.isSafeInteger(live.sequence) || live.sequence < 1 || !statuses.includes(live.status as LiveProgress["status"]) ||
        !Array.isArray(live.lines) || live.lines.length > LIVE_LINES) throw new TypeError("Invalid live progress");
      const lines = live.lines.map((line: unknown) => { text(line); return line; });
      if (live.parentId !== undefined) text(live.parentId);
      if (live.preparation !== undefined && typeof live.preparation !== "boolean") throw new TypeError("Invalid preparation flag");
      event.live = { id: live.id, sequence: live.sequence, elapsedMs: live.elapsedMs, idleMs: live.idleMs,
        status: live.status as LiveProgress["status"], lines,
        ...(typeof live.preparation === "boolean" ? { preparation: live.preparation } : {}),
        ...(typeof live.parentId === "string" ? { parentId: live.parentId } : {}) };
    }
    if (item.summary !== undefined) {
      const summary = object(item.summary);
      number(summary.total); number(summary.prepared); number(summary.completed);
      if (![summary.total, summary.prepared, summary.completed].every(Number.isSafeInteger) || summary.prepared > summary.total || summary.completed > summary.total) throw new TypeError("Invalid progress summary");
      event.summary = { total: summary.total, prepared: summary.prepared, completed: summary.completed };
    }
    return safeProgress(event);
  });
  return { schemaVersion: 1, publisherId: root.publisherId, sequence: root.sequence, events,
    ...(typeof root.ageMs === "number" ? { ageMs: root.ageMs } : {}),
    ...(typeof root.ended === "boolean" ? { ended: root.ended } : {}) };
}

export class ProgressPublisher {
  private readonly state = new ProgressSnapshots();
  private readonly publisherId = randomUUID();
  private sequence = 0;
  private closed = false;
  private sending: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  readonly observe: ProgressListener = event => {
    if (this.closed) return;
    this.state.observe(safeProgress(event, this.secrets));
    if (event.live && !["started", "updated"].includes(event.live.status)) void this.flush();
  };
  constructor(private readonly send: (snapshot: ProgressSnapshot, signal: AbortSignal) => Promise<unknown>, private readonly secrets: readonly string[] = []) {
    this.timer = setInterval(() => void this.flush(), 1000); this.timer.unref();
  }
  private flush(ended = false): Promise<void> {
    if (this.sending) return this.sending;
    const events = this.state.snapshot();
    const snapshot: ProgressSnapshot = { schemaVersion: 1, publisherId: this.publisherId, sequence: ++this.sequence, events, ...(ended ? { ended: true } : {}) };
    // Preserve statuses under pressure; preview text is expendable.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > LIVE_BUDGET) for (const event of events) if (event.live) event.live.lines = [];
    if (Buffer.byteLength(JSON.stringify(snapshot)) > LIVE_BUDGET) return Promise.resolve();
    this.sending = Promise.resolve().then(() => this.send(snapshot, AbortSignal.timeout(2000))).then(() => {}, () => {})
      .finally(() => { this.sending = undefined; });
    return this.sending;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    await this.sending;
    await this.flush(true);
  }
}
