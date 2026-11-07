import { open } from "node:fs/promises";

const NEWLINE = 0x0a;

/** Follows an append-only JSONL file and forwards complete lines as they appear. */
export class TrajectoryTailer {
  private polling = false;
  private offset = 0;
  private remainder = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly send: (lines: string[]) => Promise<void>,
    private readonly warn: (message: string, level?: "info" | "warning") => void,
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.inflight = this.poll(false).finally(() => { this.polling = false; });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stops polling and forwards whatever is already on disk. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.inflight = this.inflight.then(() => this.poll(true));
    await this.inflight;
  }

  private async poll(flush: boolean): Promise<void> {
    let lines: string[] = [];
    try {
      lines = await this.readNewLines(flush);
    } catch (error) {
      if (!isMissing(error)) {
        this.warn(`cannot read trajectory: ${describe(error)}`, "warning");
      }
      return;
    }
    if (!lines.length) return;
    try {
      await this.send(lines);
    } catch (error) {
      this.warn(`cannot forward trajectory lines: ${describe(error)}`, "warning");
    }
  }

  private async readNewLines(flush: boolean): Promise<string[]> {
    const handle = await open(this.path, "r");
    let appended: Buffer | null = null;
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
      }
      if (size > this.offset) {
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
        this.offset += bytesRead;
        appended = buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }

    if (appended) this.remainder = Buffer.concat([this.remainder, appended]);
    const cut = this.remainder.lastIndexOf(NEWLINE);
    let lines: string[] = [];
    if (cut >= 0) {
      lines = this.remainder.subarray(0, cut).toString("utf8").split("\n").filter(line => line.trim() !== "");
      this.remainder = this.remainder.subarray(cut + 1);
    }
    if (flush && this.remainder.length > 0) {
      const tail = this.remainder.toString("utf8").trim();
      this.remainder = Buffer.alloc(0);
      if (tail !== "") lines.push(tail);
    }
    return lines;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
