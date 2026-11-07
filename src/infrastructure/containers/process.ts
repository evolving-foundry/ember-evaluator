import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { CommandSpec, ExitResult, ProcessHandle } from "../../core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand } from "./runtime-contract.js";

const STREAM_BUFFER_BYTES = 1024 * 1024;
const FORCE_WAIT_MS = 2_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}
function aborted(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

class BoundedTail implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private failure: unknown;
  private waiter: { resolve(value: IteratorResult<Uint8Array>): void; reject(error: unknown): void } | null = null;
  private iterated = false;
  constructor(
    stream: Readable,
    private readonly limit = STREAM_BUFFER_BYTES,
  ) {
    void this.drain(stream);
  }
  private async drain(stream: Readable): Promise<void> {
    try {
      for await (const value of stream) this.push(Buffer.from(value as Uint8Array));
      this.finish();
    } catch (error) {
      this.failure = error;
      this.finish();
    }
  }
  private push(chunk: Uint8Array): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.bytes > this.limit && this.chunks.length) {
      const first = this.chunks[0];
      if (!first) break;
      const excess = this.bytes - this.limit;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(excess);
        this.bytes -= excess;
      }
    }
  }
  private finish(): void {
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      this.failure === undefined ? waiter.resolve({ value: undefined, done: true }) : waiter.reject(this.failure);
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterated) throw new TypeError("process output can only be consumed once");
    this.iterated = true;
    return {
      next: async () => {
        const chunk = this.chunks.shift();
        if (chunk) {
          this.bytes -= chunk.byteLength;
          return { value: chunk, done: false };
        }
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

export type DockerProcessOptions = {
  dockerExecutable: string;
  containerId: string;
  command: DockerCommand;
};

export async function startDockerProcess(
  options: DockerProcessOptions,
  spec: CommandSpec,
  signal: AbortSignal,
): Promise<ProcessHandle> {
  if (signal.aborted) throw aborted();
  if (spec.user !== undefined && !/^[a-z_][a-z0-9_-]*$/u.test(spec.user)) throw new TypeError("Invalid exec user");
  const token = randomUUID();
  const environment = Object.entries(spec.env).flatMap(([key, value]) => {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0"))
      throw new TypeError("invalid environment entry");
    return ["--env", `${key}=${value}`];
  });
  const child = spawn(
    options.dockerExecutable,
    [
      "exec",
      "--interactive",
      ...(spec.user === undefined ? [] : ["--user", spec.user]),
      "--workdir",
      spec.cwd,
      ...environment,
      options.containerId,
      EVALUATOR_NODE_EXECUTABLE,
      PROCESS_HELPER,
      "run",
      token,
      spec.executable === "node" ? EVALUATOR_NODE_EXECUTABLE : spec.executable,
      ...spec.args,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    },
  );
  await waitForSpawn(child);
  const stdout = new BoundedTail(child.stdout);
  const stderr = new BoundedTail(child.stderr);
  let settled = false;
  const done = new Promise<ExitResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      settled = true;
      resolve({ code, signal: exitSignal });
    });
  });
  let stopping: Promise<void> | null = null;
  const handle: ProcessHandle = {
    stdout,
    stderr,
    done: done.then(async exit => {
      // The exec client can exit before stop() stops the container. Consumers
      // must not start collecting evidence while that stop is still in flight.
      if (stopping) await stopping;
      return exit;
    }),
    stop(graceMs: number): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        if (settled) return;
        await options
          .command(["exec", options.containerId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "signal", token, "SIGTERM"], {
            signal: AbortSignal.timeout(FORCE_WAIT_MS),
          })
          .catch(() => {});
        await Promise.race([
          done.then(
            () => undefined,
            () => undefined,
          ),
          wait(graceMs),
        ]);
        // An exec descendant can call setsid(2) and leave the tracked process
        // group. Stopping the container is the only boundary it cannot leave.
        let stopFailed = false;
        let stopFailure: unknown;
        try {
          await options.command(["stop", "--time", "0", options.containerId], {
            signal: AbortSignal.timeout(FORCE_WAIT_MS),
          });
        } catch (error) {
          stopFailed = true;
          stopFailure = error;
        }
        const clientSettled = await Promise.race([
          done.then(
            () => true,
            () => true,
          ),
          wait(FORCE_WAIT_MS).then(() => false),
        ]);
        if (!clientSettled) {
          child.kill("SIGKILL");
          await Promise.race([
            done.then(
              () => undefined,
              () => undefined,
            ),
            wait(FORCE_WAIT_MS),
          ]);
        }
        if (stopFailed) throw stopFailure;
      })();
      return stopping;
    },
  };
  const abort = () => {
    void handle.stop(500).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  void done.finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  child.stdin.on("error", error => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") child.emit("error", error);
  });
  child.stdin.end(spec.input ?? undefined);
  if (signal.aborted) abort();
  return handle;
}
