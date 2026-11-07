import type { AttemptRecord } from "../contracts/result.js";
import type { TaskJob } from "../contracts/scheduler.js";
import type { DispatchEntry } from "../preparation/task-preparation.js";

type QueuedAttempt = DispatchEntry & { expectedFailure?: string };

/** Dispatch initial jobs and reruns admitted by the coordinator. */
export class TaskQueue implements AsyncIterable<QueuedAttempt> {
  private queue: QueuedAttempt[] = [];
  private active = new Set<string>();
  private reserved = new Set<string>();
  private changed = Promise.withResolvers<void>();
  private initialDone = false;
  private initial: AsyncIterator<DispatchEntry> | undefined;
  private closed = false;
  private finishing = false;
  constructor(private readonly beforeClose: () => Promise<boolean> = async () => true) {}
  discard(job: TaskJob): void { this.active.delete(job.taskId); this.wake(); }
  setInitialSource(source: AsyncIterable<DispatchEntry>): void { this.initial = source[Symbol.asyncIterator](); }
  private wake(): void { this.changed.resolve(); this.changed = Promise.withResolvers<void>(); }
  private available(taskId: string): boolean {
    return !this.closed && !this.active.has(taskId) && !this.reserved.has(taskId) && !this.queue.some(entry => entry.job.taskId === taskId);
  }
  reserve(entry: DispatchEntry, expectedFailure: string): { commit(): void; release(): void } | undefined {
    const { job } = entry;
    if (this.finishing || !this.available(job.taskId)) return undefined;
    this.reserved.add(job.taskId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true; this.reserved.delete(job.taskId); this.wake();
    };
    return { commit: () => { if (!released) { release(); this.add(entry, expectedFailure); } }, release };
  }
  add(entry: DispatchEntry, expectedFailure?: string): boolean {
    if (!this.available(entry.job.taskId)) return false;
    this.queue.push(expectedFailure === undefined ? entry : { ...entry, expectedFailure });
    this.wake();
    return true;
  }
  initialComplete(): void { this.initialDone = true; this.wake(); }
  complete(record: AttemptRecord): void { this.active.delete(record.key.taskId); this.wake(); }
  close(): void { this.closed = true; void this.initial?.return?.().catch(() => {}); this.wake(); }
  async *[Symbol.asyncIterator](): AsyncIterator<QueuedAttempt> {
    while (!this.closed) {
      if (!this.initialDone && this.initial) {
        const item = await this.initial.next();
        if (this.closed) break;
        if (item.done) this.initialDone = true;
        else { this.active.add(item.value.job.taskId); yield item.value; continue; }
      }
      const changed = this.changed.promise;
      const entry = this.queue.shift();
      if (entry) { this.active.add(entry.job.taskId); yield entry; continue; }
      if (this.initialDone && !this.active.size && !this.reserved.size && !this.finishing) {
        this.finishing = true;
        try { if (await this.beforeClose()) this.closed = true; } finally { this.finishing = false; }
        if (this.closed) break;
        if (this.queue.length) continue;
      }
      await changed;
    }
  }
}
