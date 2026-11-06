import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ActivityListener, ComponentActivity } from "../contracts/activity.js";
import type { ProgressEvent, ProgressListener, LiveProgress } from "./progress.js";
import { redactDiagnostic } from "../errors/diagnostics.js";

export const LIVE_LINE_BYTES = 2048;
export const LIVE_LINES = 10;
export const LIVE_BUDGET = 2 * 1024 * 1024;

export function safeLiveText(text: string, secrets: readonly string[] = []): string {
  const safe = redactDiagnostic(stripVTControlCharacters(text), secrets).replace(/[\r\n\t]/gu, " ");
  if (Buffer.byteLength(safe) <= LIVE_LINE_BYTES) return safe;
  // Cut after redaction, without splitting a UTF-8 code point.
  let result = "";
  let bytes = 0;
  for (const character of safe) {
    bytes += Buffer.byteLength(character);
    if (bytes > LIVE_LINE_BYTES - 3) break;
    result += character;
  }
  return result + "…";
}

export function safeProgress(event: ProgressEvent, secrets: readonly string[] = []): ProgressEvent {
  return { ...event, message: event.live ? safeLiveText(event.message, secrets) : redactDiagnostic(event.message, secrets),
    ...(event.taskId === undefined ? {} : { taskId: safeLiveText(event.taskId, secrets) }),
    ...(event.live ? { live: { ...event.live, id: safeLiveText(event.live.id, secrets),
      ...(event.live.parentId === undefined ? {} : { parentId: safeLiveText(event.live.parentId, secrets) }),
      lines: event.live.lines.slice(-LIVE_LINES).map(line => safeLiveText(line, secrets)) } } : {}) };
}

/** Source-local monotonic clocks. Receiving a repeated snapshot never constitutes activity. */
export class LiveOperation {
  private readonly started = performance.now();
  private lastActivity = this.started;
  private sequence = 0;
  private closed = false;
  private lines: string[] = [];
  private readonly children = new Map<string, LiveOperation>();
  private readonly finishedChildren = new Set<string>();
  private message: string;
  readonly id: string;
  readonly activity: ActivityListener = event => this.update(event);

  constructor(private readonly listener: ProgressListener | undefined,
    private readonly event: Pick<ProgressEvent, "phase" | "message" | "taskId" | "attemptId">,
    private readonly secrets: readonly string[] = [], parentId?: string, identity = "operation", private readonly preparation = false) {
    this.id = `${identity}/${randomUUID()}`;
    this.message = safeLiveText(event.message, secrets);
    this.parentId = parentId;
    this.emit("started");
  }
  private readonly parentId: string | undefined;

  private emit(status: LiveProgress["status"]): void {
    const now = performance.now();
    this.listener?.(safeProgress({ ...this.event, message: status === "started" || status === "updated" ? this.message : this.event.message, transient: true,
      live: { id: this.id, ...(this.parentId ? { parentId: this.parentId } : {}), sequence: ++this.sequence,
        status, elapsedMs: now - this.started, idleMs: now - this.lastActivity, lines: [...this.lines],
        ...(this.preparation ? { preparation: true } : {}) } }, this.secrets));
  }
  update(event: ComponentActivity): void {
    if (this.closed) return;
    if (event.operationId) {
      if (this.finishedChildren.has(event.operationId)) return;
      let child = this.children.get(event.operationId);
      if (child?.closed) return;
      if (!child) {
        child = new LiveOperation(this.listener, { ...this.event, message: event.message ?? this.message }, this.secrets, this.id, `${this.id}/${event.operationId}`);
        this.children.set(event.operationId, child);
      }
      child.update({ ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.lines === undefined ? {} : { lines: event.lines }), ...(event.activity === undefined ? {} : { activity: event.activity }) });
      if (event.status && !["started", "updated"].includes(event.status)) {
        child.finish(event.status as "completed" | "failed" | "cancelled");
        this.children.delete(event.operationId); this.finishedChildren.add(event.operationId);
        if (this.finishedChildren.size > 4096) {
          const id = this.finishedChildren.values().next().value;
          if (id !== undefined) this.finishedChildren.delete(id);
        }
      }
      if (event.activity !== false) this.lastActivity = performance.now();
      this.emit("updated");
      return;
    }
    if (event.activity !== false) this.lastActivity = performance.now();
    if (event.message !== undefined) this.message = safeLiveText(event.message, this.secrets);
    for (const line of event.lines ?? []) {
      const safe = safeLiveText(line, this.secrets);
      if (safe && safe !== this.lines.at(-1)) this.lines.push(safe);
    }
    this.lines = this.lines.slice(-LIVE_LINES);
    this.emit("updated");
  }
  finish(status: "completed" | "failed" | "cancelled" = "completed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const child of this.children.values()) child.finish(status);
    this.children.clear();
    this.finishedChildren.clear();
    this.emit(status);
  }
}

/** Only known command/path fields are eligible; never serialize an arbitrary tool input. */
export function toolActivity(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return name;
  const fields = input as Record<string, unknown>;
  const value = fields.command ?? fields.path ?? fields.file_path;
  return typeof value === "string" ? `${name}: ${value}` : name;
}

export function toolOutputLines(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\r?\n/u).slice(-LIVE_LINES);
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? item.text.split(/\r?\n/u) : [];
  }).slice(-LIVE_LINES);
}

/** Bounded, source-owned snapshots for reconnectable transports. No disk spool. */
export class ProgressSnapshots {
  private readonly entries = new Map<string, { event: ProgressEvent; at: number }>();
  private readonly terminal = new Map<string, { sequence: number; at: number }>();
  private bytes = 0;
  private summary: ProgressEvent["summary"];
  observe(event: ProgressEvent): boolean {
    if (event.summary) this.summary = { ...event.summary };
    const live = event.live;
    if (!live || this.terminal.has(live.id)) return false;
    const previous = this.entries.get(live.id);
    if (previous?.event.live && previous.event.live.sequence >= live.sequence) return false;
    const safe = safeProgress({ phase: event.phase, message: event.message, transient: true, live,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.taskNumber === undefined ? {} : { taskNumber: event.taskNumber }),
      ...(event.taskTotal === undefined ? {} : { taskTotal: event.taskTotal }) });
    this.bytes -= previous ? this.size(previous.event) : 0;
    // Keep new observations by shedding the oldest preview bodies first.
    for (const item of this.entries.values()) {
      if (this.bytes + this.size(safe) <= LIVE_BUDGET) break;
      if (item.event.live && item !== previous) { this.bytes -= this.size(item.event); item.event.live.lines = []; }
    }
    this.entries.set(live.id, { event: safe, at: performance.now() });
    this.bytes += this.size(safe);
    if (live.status !== "started" && live.status !== "updated") this.terminal.set(live.id, { sequence: live.sequence, at: performance.now() });
    this.prune();
    return true;
  }
  private size(event: ProgressEvent): number { return event.live?.lines.reduce((n, line) => n + Buffer.byteLength(line), 0) ?? 0; }
  private prune(): void {
    const now = performance.now();
    for (const [id, item] of this.entries) if (item.event.live && !["started", "updated"].includes(item.event.live.status) && now - item.at > 60_000) {
      this.bytes -= this.size(item.event); this.entries.delete(id);
    }
    // Tombstones are bounded as well; an operation UUID is never reused by its source.
    for (const [id, item] of this.terminal) if (now - item.at > 60_000) this.terminal.delete(id);
    while (this.terminal.size > 4096) {
      const id = this.terminal.keys().next().value;
      if (id === undefined) break;
      this.terminal.delete(id);
    }
    while (this.entries.size > 4096) {
      const id = this.entries.keys().next().value;
      if (id === undefined) break;
      const event = this.entries.get(id)?.event;
      if (event) this.bytes -= this.size(event);
      this.entries.delete(id);
    }
  }
  snapshot(): ProgressEvent[] {
    this.prune();
    const now = performance.now();
    const result = [...this.entries.values()].map(({ event, at }) => ({ ...event,
      ...(event.live ? { live: { ...event.live, elapsedMs: event.live.elapsedMs + (this.terminal.has(event.live.id) ? 0 : now - at),
        idleMs: event.live.idleMs + (this.terminal.has(event.live.id) ? 0 : now - at), lines: [...event.live.lines] } } : {}) }));
    if (this.summary) result.push({ phase: "progress", message: "Evaluation progress", transient: true, summary: { ...this.summary } });
    return result;
  }
}
