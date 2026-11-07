import type { ErrorCode } from "../errors/registry.js";
import { open, type FileHandle } from "node:fs/promises";

import type { AttemptKey } from "../contracts/result.js";
import type { JsonValue } from "../contracts/task.js";

export type TrajectoryEvent = {
  schemaVersion: 1;
  key: AttemptKey;
  seq: number;
  at: string;
  type: string;
  data: JsonValue;
};

export function validateSequence(events: TrajectoryEvent[]): { complete: boolean; missing: number[] } {
  const observed = new Set(events.map(event => event.seq));
  const missing: number[] = [];
  const maximum = Math.max(0, ...events.map(event => (Number.isSafeInteger(event.seq) ? event.seq : 0)));
  for (let expected = 1; expected <= maximum; expected += 1) {
    if (!observed.has(expected)) missing.push(expected);
  }
  const contiguous =
    missing.length === 0 && maximum === events.length && events.every((event, index) => event.seq === index + 1);
  const oneEnd = events.filter(event => event.type === "end").length === 1;
  return {
    complete: contiguous && oneEnd && events.at(-1)?.type === "end",
    missing,
  };
}

export class TrajectoryQueueOverflowError extends Error {
  readonly code: ErrorCode = "SOLVER_PROTOCOL_INVALID";

  constructor(maximumPending: number) {
    super(`trajectory queue capacity ${maximumPending} exceeded`);
    this.name = "TrajectoryQueueOverflowError";
  }
}

export class TrajectoryWriter {
  private handle: FileHandle | null = null;
  private chain = Promise.resolve();
  private failed: unknown;
  private closed = false;
  private pending = 0;
  private sequence = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly path: string,
    private readonly key: AttemptKey,
    private readonly maximumPending = 256,
  ) {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, 1_000);
    this.timer.unref();
  }

  private async file(): Promise<FileHandle> {
    return (this.handle ??= await open(this.path, "a", 0o600));
  }

  append(type: string, data: JsonValue, durable = false): Promise<TrajectoryEvent> {
    if (this.closed) return Promise.reject(new Error("trajectory writer is closed"));
    if (this.failed !== undefined) return Promise.reject(this.failed);
    if (this.pending >= this.maximumPending) {
      return Promise.reject(new TrajectoryQueueOverflowError(this.maximumPending));
    }
    const event: TrajectoryEvent = {
      schemaVersion: 1,
      key: this.key,
      seq: ++this.sequence,
      at: new Date().toISOString(),
      type,
      data,
    };
    this.pending += 1;
    const write = this.chain.then(async () => {
      const handle = await this.file();
      await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      if (durable) await handle.sync();
    });
    this.chain = write
      .catch(error => {
        this.failed = error;
      })
      .finally(() => {
        this.pending -= 1;
      });
    return write.then(() => event);
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.failed !== undefined) throw this.failed;
    if (this.handle) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    try {
      await this.flush();
    } finally {
      if (this.handle) await this.handle.close();
      this.handle = null;
    }
  }
}
