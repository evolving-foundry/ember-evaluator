import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { ActivityListener } from "../../core/contracts/activity.js";
import type { DockerCommand } from "./runtime-contract.js";

// Per-call context, including shared-build fanout; never stored on an Environment instance.
const context = new AsyncLocalStorage<ActivityListener>();
export const dockerActivity = (): ActivityListener | undefined => context.getStore();
export function withDockerActivity<T>(activity: ActivityListener | undefined, work: () => T): T {
  return activity ? context.run(activity, work) : work();
}

/** Decode full logical lines before redaction. An overlong line is discarded as a whole. */
export class ProgressLines {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private discarded = false;
  constructor(private readonly line: (line: string) => void, private readonly received?: () => void) {}
  push(chunk: Uint8Array): void {
    if (chunk.byteLength) this.received?.();
    const text = this.decoder.write(Buffer.from(chunk));
    for (const part of text.split(/([\r\n])/u)) {
      if (part === "\r" || part === "\n") {
        if (this.buffered && !this.discarded) this.line(this.buffered);
        this.buffered = ""; this.discarded = false;
      } else if (!this.discarded) {
        if (Buffer.byteLength(this.buffered) + Buffer.byteLength(part) > 16 * 1024) {
          this.buffered = ""; this.discarded = true;
          this.line("[Overlong output omitted]");
        } else this.buffered += part;
      }
    }
  }
  end(): void {
    this.push(Buffer.from(this.decoder.end()));
    if (this.buffered && !this.discarded) this.line(this.buffered);
    this.buffered = "";
  }
}

export function observeDockerCommand(command: DockerCommand): DockerCommand {
  return async (args, options) => {
    const activity = dockerActivity();
    if (!activity || options?.onOutput || !["pull", "build", "buildx"].includes(args[0] ?? "")) return command(args, options);
    const label = args[0] === "pull" ? "Pulling image" : "Building image";
    const operationId = randomUUID();
    const report: ActivityListener = event => activity({ ...event, operationId });
    report({ message: label, status: "started", lines: [label] });
    let lastActivity = -Infinity;
    const received = () => { const now = performance.now(); if (now - lastActivity >= 200) { lastActivity = now; report({}); } };
    const stdout = new ProgressLines(line => report({ lines: [line] }), received);
    const stderr = new ProgressLines(line => report({ lines: [line] }), received);
    // Plain BuildKit output is parseable and cannot move the parent's cursor.
    const actual = args[0] === "build" && !args.some(arg => arg.startsWith("--progress"))
      ? [args[0], "--progress=plain", ...args.slice(1)] : args;
    try {
      const result = await command(actual, { ...options,
        onOutput: (stream, chunk) => (stream === "stdout" ? stdout : stderr).push(chunk) });
      stdout.end(); stderr.end();
      report({ status: "completed", lines: [`${label} completed`] });
      return result;
    } catch (error) {
      stdout.end(); stderr.end(); report({ status: options?.signal?.aborted ? "cancelled" : "failed" }); throw error;
    }
  };
}
