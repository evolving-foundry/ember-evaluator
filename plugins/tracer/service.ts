import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { collectorCommand, type TracerConfig } from "./config.js";

export type TracerHealth = {
  ok?: boolean;
  db?: string | null;
  spool?: string;
};

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const ROTATED_LOGS = 3;

/** Rotates the Collector log once it exceeds the size budget, keeping a bounded number of generations. */
function rotateLog(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    for (let generation = ROTATED_LOGS - 1; generation >= 1; generation--) {
      try { renameSync(`${path}.${generation}`, `${path}.${generation + 1}`); } catch { /* Missing generation. */ }
    }
    renameSync(path, `${path}.1`);
  } catch { /* No log yet. */ }
}

/** Records the managed pid so `ember tracer status/stop` can find processes started by a run. */
function writePidFile(db: string, record: Record<string, unknown>): string {
  const path = join(dirname(db), "tracer.pid");
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

/**
 * Owns the Collector process lifecycle.
 *
 * A healthy Collector is reused as-is. Only when none is reachable does the plugin
 * spawn one with the persistent database and spool paths, so repeated runs share
 * history instead of starting from an empty store.
 */
export class TracerService {
  private state: "unknown" | "ready" | "unavailable" = "unknown";
  private reason: string | null = null;
  private readonly warned = new Set<string>();

  constructor(
    private readonly config: TracerConfig,
    private readonly warn: (message: string, level?: "info" | "warning") => void,
    private readonly signal?: AbortSignal,
  ) {}

  get base(): string {
    return this.config.url;
  }

  async probe(timeoutMs = 1500): Promise<TracerHealth | null> {
    try {
      const response = await fetch(`${this.config.url}/healthz`, {
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as TracerHealth;
      return body && body.ok ? body : null;
    } catch {
      return null;
    }
  }

  /** Returns whether the Collector is usable; failures are reported once and never thrown. */
  async ensure(): Promise<boolean> {
    if (this.signal?.aborted) return false;
    if (this.state === "ready") return true;
    if (this.state === "unavailable") return false;

    const health = await this.probe();
    if (health) {
      const mismatch = this.databaseMismatch(health);
      if (mismatch) {
        this.fail(mismatch);
        return false;
      }
      this.state = "ready";
      this.report(`reusing Collector at ${this.config.url} (db ${health.db ?? this.config.db})`);
      return true;
    }

    if (!this.config.autostart) {
      this.fail(`tracer is not reachable at ${this.config.url} and autostart is disabled`);
      return false;
    }

    try {
      await this.start();
      this.state = "ready";
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private databaseMismatch(health: TracerHealth): string | null {
    if (!health.db) return null;
    if (resolve(health.db) === resolve(this.config.db)) return null;
    return `tracer at ${this.config.url} uses database ${health.db}, but ${this.config.db} is configured; `
      + "refusing to mix histories (stop it or point tracer.db at the running database)";
  }

  private fail(message: string): void {
    this.state = "unavailable";
    this.reason = message;
    this.report(message, "warning");
  }

  private report(message: string, level: "info" | "warning" = "info"): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message, level);
  }

  private async start(): Promise<void> {
    this.signal?.throwIfAborted();
    try {
      await access(this.config.collector);
    } catch {
      throw new Error(`Collector entrypoint not found: ${this.config.collector}; `
        + "build it with \"pnpm build\" or set tracer.collector / TRACER_COLLECTOR");
    }

    const url = new URL(this.config.url);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const args = [
      ...collectorCommand(this.config.collector),
      "--host", url.hostname,
      "--port", port,
      "--db", this.config.db,
      "--spool", this.config.spool,
    ];
    // The bearer token travels through the environment: argv is visible to every local user via ps.
    const env = this.config.token ? { ...process.env, TRACER_TOKEN: this.config.token } : process.env;

    const log = join(dirname(this.config.db), "collector.log");
    rotateLog(log);
    this.signal?.throwIfAborted();
    const fd = openLog(log);
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, env, stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"] });
    if (fd !== undefined) closeSync(fd);
    let exited: string | null = null;
    child.once("error", error => {
      exited = error.message;
    });
    child.once("exit", (code, signal) => {
      exited = `exited with ${signal ?? `code ${code ?? "unknown"}`}`;
    });
    child.unref();
    const pidFile = writePidFile(this.config.db, {
      pid: child.pid,
      url: this.config.url,
      db: this.config.db,
      spool: this.config.spool,
      collector: this.config.collector,
      log,
      startedAt: new Date().toISOString(),
    });

    try {
      const deadline = Date.now() + this.config.timeoutMs;
      while (Date.now() < deadline) {
        this.signal?.throwIfAborted();
        const health = await this.probe(1000);
        if (health) {
          const mismatch = this.databaseMismatch(health);
          if (mismatch) throw new Error(mismatch);
          this.report(`started ${this.config.collector} at ${this.config.url}`);
          return;
        }
        if (exited) {
          const tail = await readTail(log);
          throw new Error(`Collector ${exited}; entrypoint: ${this.config.collector}; db: ${this.config.db}; log: ${log}`
            + (tail ? `\n${tail}` : ""));
        }
        await delay(300);
      }
      throw new Error(`Collector did not become healthy at ${this.config.url} within ${this.config.timeoutMs}ms`);
    } catch (error) {
      child.kill();
      rmSync(pidFile, { force: true });
      throw error;
    }
  }

  /** Diagnostics for the caller; the service itself is intentionally left running for reuse. */
  get failure(): string | null {
    return this.reason;
  }
}

function openLog(path: string): number | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return openSync(path, "a");
  } catch {
    return undefined;
  }
}

/** Last lines of the Collector log; the startup failure reason usually lives there. */
async function readTail(path: string, lines = 8): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trimEnd().split(/\r?\n/u).slice(-lines).join("\n");
  } catch {
    return "";
  }
}
