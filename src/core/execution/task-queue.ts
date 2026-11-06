import type { AttemptRecord } from "../contracts/result.js";
import type { TaskJob } from "../contracts/scheduler.js";

/** Dispatch initial jobs and reruns admitted by the coordinator. */
export class TaskQueue implements AsyncIterable<TaskJob> {
  private queue: TaskJob[] = [];
  private active = new Set<string>();
  private expectedFailures = new Map<string, string>();
  private reserved = new Set<string>();
  private changed = Promise.withResolvers<void>();
  private initialDone = false;
  private initial: AsyncIterator<TaskJob> | undefined;
  private closed = false;
  private finishing = false;
  constructor(private readonly beforeClose: () => Promise<boolean> = async () => true) {}
  expectedFailure(attemptId: string): string | undefined { return this.expectedFailures.get(attemptId); }
  discard(job: TaskJob): void { this.active.delete(job.taskId); this.wake(); }
  setInitialSource(source: AsyncIterable<TaskJob>): void { this.initial = source[Symbol.asyncIterator](); }
  private wake(): void { this.changed.resolve(); this.changed = Promise.withResolvers<void>(); }
  private available(taskId: string): boolean {
    return !this.closed && !this.active.has(taskId) && !this.reserved.has(taskId) && !this.queue.some(job => job.taskId === taskId);
  }
  reserve(job: TaskJob, expectedFailure: string): { commit(): void; release(): void } | undefined {
    if (this.finishing || !this.available(job.taskId)) return undefined;
    this.reserved.add(job.taskId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true; this.reserved.delete(job.taskId); this.wake();
    };
    return { commit: () => { if (!released) { release(); this.add(job, expectedFailure); } }, release };
  }
  add(job: TaskJob, expectedFailure?: string): boolean {
    if (!this.available(job.taskId)) return false;
    if (expectedFailure) this.expectedFailures.set(job.attemptId, expectedFailure);
    this.queue.push(job); this.wake(); return true;
  }
  initialComplete(): void { this.initialDone = true; this.wake(); }
  complete(record: AttemptRecord): void { this.active.delete(record.key.taskId); this.wake(); }
  close(): void { this.closed = true; void this.initial?.return?.().catch(() => {}); this.wake(); }
  async *[Symbol.asyncIterator](): AsyncIterator<TaskJob> {
    while (!this.closed) {
      if (!this.initialDone && this.initial) {
        const item = await this.initial.next();
        if (this.closed) break;
        if (item.done) this.initialDone = true;
        else { this.active.add(item.value.taskId); yield item.value; continue; }
      }
      const changed = this.changed.promise;
      const job = this.queue.shift();
      if (job) { this.active.add(job.taskId); yield job; continue; }
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
