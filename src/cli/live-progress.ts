import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProgressEvent } from "../core/progress/progress.js";
import { LIVE_LINES, safeProgress, safeLiveText } from "../core/progress/live-progress.js";

export type ProgressMode = "auto" | "tty" | "plain";
type Entry = { event: ProgressEvent; received: number; order: number };
const running = (event: ProgressEvent) => event.live?.status === "started" || event.live?.status === "updated";

function taskPrefix(event: ProgressEvent): string {
  if (!event.taskId) return "";
  const position = event.taskNumber ? `Task ${event.taskNumber}/${event.taskTotal} ` : "";
  return `${position}${event.taskId} `;
}

/** Owns only its bottom-of-terminal region. Plain logs and results remain ordinary lines. */
export class CliLiveProgress {
  private readonly entries = new Map<string, Entry>();
  private readonly ended = new Map<string, number>();
  private readonly completed = new Set<string>();
  private readonly prepared = new Set<string>();
  private rendered: string[] = [];
  private closed = false;
  private lastPaint = -Infinity;
  private order = 0;
  private total = 0;
  private summary: ProgressEvent["summary"];
  private readonly interrupted = new Set<string>();
  private fallback: Entry | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly resize = () => this.guard(() => { this.erase(); this.paint(); });
  constructor(private readonly stream: NodeJS.WriteStream, private readonly line: (text: string) => void,
    private readonly color = process.env.NO_COLOR === undefined) {
    this.timer = setInterval(() => this.guard(() => this.schedule()), 1000);
    this.timer.unref();
    stream.on("resize", this.resize);
  }
  static enabled(mode: ProgressMode, stream: NodeJS.WriteStream | undefined): stream is NodeJS.WriteStream {
    return mode !== "plain" && stream?.isTTY === true && process.env.TERM !== "dumb"
      && (mode === "tty" || !process.env.CI || /^(0|false)$/iu.test(process.env.CI));
  }
  private guard(work: () => void): void {
    if (this.closed) return;
    try { work(); } catch { this.close(); }
  }
  private erase(): void {
    if (!this.rendered.length) return;
    const columns = Math.max(1, this.stream.columns || 80);
    const rows = this.rendered.reduce((n, line) => n + Math.max(1, Math.ceil(visibleWidth(line) / columns)), 0);
    this.stream.write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[J`);
    this.rendered = [];
  }
  write(work: () => void): void {
    if (this.closed) { work(); return; }
    this.guard(() => this.erase());
    work();
    this.guard(() => this.schedule());
  }
  observe(raw: ProgressEvent): void {
    this.guard(() => {
      const event = safeProgress(raw);
      const now = performance.now();
      if (event.summary) { this.summary = event.summary; this.total = event.summary.total; }
      if (event.connection) {
        if (event.connection === "unsupported") { this.close(); return; }
        const key = event.taskId ?? "cluster";
        if (event.connection === "interrupted") this.interrupted.add(key); else this.interrupted.delete(key);
        this.schedule(); return;
      }
      if (event.taskTotal !== undefined) this.total = event.taskTotal;
      if (!event.transient && event.taskId && event.phase === "task" && event.message.startsWith("Finished:")) this.completed.add(event.taskId);
      const live = event.live;
      if (!live) {
        if (!event.taskId && !event.transient) {
          const previous = this.fallback;
          this.fallback = { event, received: now, order: previous?.event.phase === event.phase ? previous.order : now };
        }
        this.schedule(); return;
      }
      if (this.ended.has(live.id)) return;
      const previous = this.entries.get(live.id);
      if (previous?.event.live && previous.event.live.sequence >= live.sequence) return;
      if (running(event)) this.entries.set(live.id, { event, received: now, order: previous?.order ?? ++this.order });
      else {
        this.entries.delete(live.id);
        if (!event.taskId && this.fallback?.event.phase === event.phase) this.fallback = undefined;
        this.ended.set(live.id, now);
        if (live.status === "completed" && live.preparation && event.taskId) this.prepared.add(event.taskId);
        this.erase();
        const task = taskPrefix(event);
        const icon = live.status === "completed" ? "✓" : live.status === "cancelled" ? "−" : "✗";
        this.line(`${icon} ${task}[${event.phase}] ${event.message}; ${(live.elapsedMs / 1000).toFixed(1)}s; ${live.status}`);
        if (live.status === "failed") for (const line of live.lines.slice(-5)) this.line(`  ${line}`);
      }
      // Late events cannot resurrect recently ended operations; bound long-running retry histories.
      for (const [id, at] of this.ended) if (now - at > 60_000 && this.ended.size > 4096) this.ended.delete(id);
      while (this.ended.size > 4096) {
        const id = this.ended.keys().next().value;
        if (id === undefined) break;
        this.ended.delete(id);
      }
      this.schedule();
    });
  }
  private schedule(): void {
    if (this.pending || this.closed) return;
    const wait = Math.max(0, 200 - (performance.now() - this.lastPaint));
    if (!wait) { this.paint(); return; }
    this.pending = setTimeout(() => { this.pending = undefined; this.guard(() => this.paint()); }, wait);
    this.pending.unref();
  }
  private paint(): void {
    if (this.closed) return;
    this.lastPaint = performance.now();
    this.erase();
    const now = performance.now();
    const width = Math.max(1, (this.stream.columns || 80) - 1);
    const tasks = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const key = entry.event.taskId ?? entry.event.live?.id ?? "global";
      if ((tasks.get(key)?.order ?? -1) <= entry.order) tasks.set(key, entry);
    }
    let entries = [...tasks.values()];
    if (entries.some(entry => entry.event.taskId !== undefined)) entries = entries.filter(entry => entry.event.taskId !== undefined);
    if (!entries.length && this.fallback && !["complete", "dispose", "finalize"].includes(this.fallback.event.phase)) entries = [this.fallback];
    if (!entries.length) return;
    const age = (entry: Entry) => (entry.event.live?.idleMs ?? 0) + now - entry.received;
    entries.sort((a, b) => Number(age(b) >= 60_000) - Number(age(a) >= 60_000) || a.order - b.order);
    const maximum = Math.max(1, Math.min(20, Math.floor((this.stream.rows || 24) / 2)));
    const available = Math.max(0, maximum - 1);
    const shown = entries.slice(0, Math.max(0, available - (entries.length > available ? 1 : 0)));
    const solve = [...tasks.values()].filter(entry => entry.event.phase === "solve").length;
    const verify = [...tasks.values()].filter(entry => entry.event.phase === "verify").length;
    const lines = [`Evaluation: ready ${this.summary?.prepared ?? this.prepared.size}/${this.total || "?"} · completed ${this.summary?.completed ?? this.completed.size}/${this.total || "?"} · solving ${solve} · verifying ${verify}${this.interrupted.size ? " · progress disconnected" : ""}`];
    const taskLines: { status: string; tail: string[] }[] = [];
    for (const entry of shown) {
      const event = entry.event;
      const elapsed = (event.live?.elapsedMs ?? now - entry.order) + (event.live ? now - entry.received : 0);
      const task = taskPrefix(event);
      const timing = ` · ${(elapsed / 1000).toFixed(0)}s · idle ${(age(entry) / 1000).toFixed(0)}s${age(entry) >= 60_000 ? " check activity" : ""}`;
      taskLines.push({ status: `${truncateToWidth(`⠋ ${task}[${event.phase}] ${event.message}`, Math.max(1, width - visibleWidth(timing)), "…")}${timing}`,
        tail: event.live?.lines.slice(-LIVE_LINES).map(line => `  ${line}`) ?? [] });
    }
    const hidden = shown.length < entries.length;
    let tailBudget = maximum - 1 - shown.length - (hidden ? 1 : 0);
    for (const task of taskLines) {
      lines.push(task.status);
      const count = Math.min(task.tail.length, tailBudget);
      if (count > 0) lines.push(...task.tail.slice(-count));
      tailBudget -= count;
    }
    if (hidden && lines.length < maximum) lines.push(`… ${entries.length - shown.length} more active tasks hidden`);
    this.rendered = lines.slice(0, maximum).map(line => truncateToWidth(safeLiveText(line), width, "…"));
    const text = this.rendered.join("\n");
    this.stream.write(this.color ? `\x1b[90m${text}\x1b[0m` : text);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.stream.off("resize", this.resize);
    try { this.erase(); } catch { /* Presentation failure must not stop resource release. */ }
    this.entries.clear(); this.ended.clear(); this.fallback = undefined;
  }
}
