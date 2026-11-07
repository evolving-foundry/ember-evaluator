import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProgressSnapshots } from "../../core/progress/live-progress.js";
import { parseProgressSnapshot, ProgressPublisher, type ProgressSnapshot } from "../../core/progress/progress-wire.js";
import { JobsClient } from "./jobs-client.js";

/** Gateway RAM only. An ended publisher expires even if nobody reads its progress. */
export class JobsProgressMailbox {
  private readonly jobs = new Map<string, { publisherId: string; sequence: number; state: ProgressSnapshots; at: number; ended: boolean; retired: Set<string> }>();
  put(id: string, input: unknown): void {
    this.prune();
    const snapshot = parseProgressSnapshot(input);
    let job = this.jobs.get(id);
    if (job?.retired.has(snapshot.publisherId)) return;
    if (job?.publisherId === snapshot.publisherId && job.sequence >= snapshot.sequence) return;
    if (!job || job.publisherId !== snapshot.publisherId) {
      const retired = job?.retired ?? new Set<string>();
      if (job) retired.add(job.publisherId);
      if (retired.size > 8) {
        const first = retired.values().next().value;
        if (first !== undefined) retired.delete(first);
      }
      job = { publisherId: snapshot.publisherId, sequence: 0, state: new ProgressSnapshots(), at: performance.now(), ended: false, retired };
      this.jobs.set(id, job);
    }
    job.sequence = snapshot.sequence; job.at = performance.now(); job.ended = snapshot.ended === true;
    for (const event of snapshot.events) job.state.observe(event);
  }
  get(id: string): ProgressSnapshot {
    this.prune();
    const job = this.jobs.get(id);
    return job ? { schemaVersion: 1, publisherId: job.publisherId, sequence: job.sequence, events: job.state.snapshot(), ended: job.ended, ageMs: performance.now() - job.at }
      : { schemaVersion: 1, publisherId: "pending", sequence: 1, events: [] };
  }
  prune(): void {
    const now = performance.now();
    for (const [id, job] of this.jobs) if ((job.ended && now - job.at > 60_000) || now - job.at > 300_000) this.jobs.delete(id);
    while (this.jobs.size > 32) {
      const id = this.jobs.keys().next().value;
      if (id === undefined) break;
      this.jobs.delete(id);
    }
  }
}

export async function createJobsProgressPublisher(id: string, secrets: readonly string[] = []): Promise<ProgressPublisher | undefined> {
  try {
    const endpoint = new URL(process.env.EVALUATOR_JOBS_PROGRESS_ORIGIN ?? "https://gateway:9443");
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
      throw new TypeError("Invalid internal progress origin");
    const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
    const token = (await readFile(join(security, "jobs-token"), "utf8")).trim();
    const client = new JobsClient(endpoint.origin, await readFile(join(security, "cert.pem")), token);
    return new ProgressPublisher((snapshot, signal) => client.call(`/jobs/${id}/progress`, snapshot, signal), [...secrets, token]);
  } catch { return undefined; }
}
