import type { TracerConfig } from "./config.js";
import { TracerService } from "./service.js";

const MAX_LINES_PER_POST = 400;
const MAX_BYTES_PER_POST = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/** Best-effort Collector client; transport failures never break an evaluation. */
export class TracerClient {
  private readonly service: TracerService;
  private usable = false;

  constructor(
    private readonly config: TracerConfig,
    private readonly warn: (message: string, level?: "info" | "warning") => void,
    private readonly signal?: AbortSignal,
  ) {
    this.service = new TracerService(config, warn, signal);
  }

  async begin(epoch: string, fingerprint?: string, config?: unknown): Promise<void> {
    if (!(await this.ensure())) return;
    // Structured config enables per-domain attribution (model/harness/infra/benchmark); a fingerprint only tells whether something changed
    const body = JSON.stringify({
      epoch,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      ...(config === undefined ? {} : { config }),
    });
    await this.post("/v1/runs", body);
  }

  async finish(epoch: string): Promise<void> {
    if (!(await this.ensure())) return;
    await this.post(`/v1/runs/${encodeURIComponent(epoch)}/finish`, "{}");
  }

  /** Sends raw Evaluator trajectory events and/or result rows as NDJSON. */
  async ingest(attemptId: string, lines: readonly string[]): Promise<void> {
    const rows = lines.filter(line => line.trim() !== "");
    if (!rows.length || !(await this.ensure())) return;
    const query = `?session=${encodeURIComponent(attemptId)}`;
    for (const chunk of chunkLines(rows)) {
      await this.post(`/v1/ingest${query}`, chunk.join("\n") + "\n", "application/x-ndjson");
    }
  }

  /** Records where the deterministic signals were persisted, for the panel to display. */
  async artifacts(epoch: string, artifacts: Record<string, string>): Promise<void> {
    if (!(await this.ensure())) return;
    await this.post(`/v1/runs/${encodeURIComponent(epoch)}/artifacts`, JSON.stringify(artifacts));
  }

  /** Reads a Collector endpoint as text; returns null when the service is unreachable. */
  async get(path: string): Promise<string | null> {
    if (!(await this.ensure())) return null;
    try {
      const response = await fetch(this.service.base + path, {
        headers: this.config.token ? { authorization: `Bearer ${this.config.token}` } : {},
        signal: this.requestSignal(),
      });
      if (!response.ok) {
        this.warn(`GET ${path} failed (${response.status} ${response.statusText})`, "warning");
        return null;
      }
      return await response.text();
    } catch (error) {
      this.warn(`GET ${path} failed (${error instanceof Error ? error.message : String(error)})`, "warning");
      return null;
    }
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private async ensure(): Promise<boolean> {
    if (this.signal?.aborted) return false;
    if (this.usable) return true;
    this.usable = await this.service.ensure();
    return this.usable;
  }

  private async post(path: string, body: string, contentType = "application/json"): Promise<void> {
    let last = "unknown error";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.signal?.aborted) return;
      try {
        const response = await fetch(this.service.base + path, {
          method: "POST",
          headers: {
            "content-type": contentType,
            ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
          },
          body,
          signal: this.requestSignal(),
        });
        if (response.ok) return;
        last = `${response.status} ${response.statusText}`;
        if (response.status !== 429 && response.status < 500) break;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (attempt < MAX_ATTEMPTS) await delay(500 * attempt);
    }
    this.warn(`POST ${path} failed (${last})`, "warning");
  }
}

function chunkLines(lines: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (current.length && (current.length >= MAX_LINES_PER_POST || bytes + size > MAX_BYTES_PER_POST)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(line);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
