import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { DockerEnvironmentError } from "./error.js";

const DOCKER_OUTPUT_LIMIT = 4 * 1024 * 1024;

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null };

// On Windows, plugin commands such as `docker build` run in a CLI plugin
// process (docker-buildx.exe) started by docker.exe. Killing only docker.exe
// leaves the plugin building with the inherited pipes, so kill the whole tree.
function killDockerClient(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  return new Promise(resolve => {
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => {
      if (error) child.kill("SIGKILL");
      resolve();
    });
  });
}

export async function runDockerCommand(
  dockerExecutable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array | null; signal?: AbortSignal; maxBuffer?: number;
    onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void } = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const child = spawn(dockerExecutable, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let observationFailure: unknown;
  let observationFailed = false;
  const notify = (stream: "stdout" | "stderr", chunk: Uint8Array) => {
    if (observationFailed) return;
    try { options.onOutput?.(stream, chunk); } catch (error) {
      observationFailed = true; observationFailure = error;
      void killDockerClient(child);
    }
  };
  const limit = options.maxBuffer ?? DOCKER_OUTPUT_LIMIT;
  const collect = (chunks: Buffer[], value: Buffer, count: number): number => {
    chunks.push(value);
    count += value.length;
    while (count > limit && chunks.length) {
      const first = chunks.shift();
      if (first) count -= first.length;
    }
    return count;
  };
  const collectOutput = (stream: "stdout" | "stderr", chunks: Buffer[]) => {
    let bytes = 0;
    child[stream].on("data", (chunk: Buffer) => {
      bytes = collect(chunks, Buffer.from(chunk), bytes);
      notify(stream, Buffer.from(chunk));
    });
  };
  collectOutput("stdout", stdout);
  collectOutput("stderr", stderr);
  child.stdin.on("error", error => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") child.emit("error", error);
  });
  child.stdin.end(options.input ?? undefined);
  let termination: Promise<void> | undefined;
  let abort = () => {};
  const result = await new Promise<ChildOutcome>((done, fail) => {
    let exited: ChildOutcome | undefined;
    // A descendant that escaped the kill still holds the inherited pipes and
    // would delay "close" until it exits; once cancelled, the client's exit is enough.
    abort = () => {
      if (exited) done(exited);
      else termination ??= killDockerClient(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (options.signal?.aborted) done(exited);
    });
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => options.signal?.removeEventListener("abort", abort));
  if (options.signal?.aborted) {
    child.stdout.destroy();
    child.stderr.destroy();
    await termination;
    throw options.signal.reason;
  }
  const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  if (observationFailed) throw observationFailure;
  if (result.code !== 0 || result.signal !== null) {
    // Docker's legacy-builder warning goes to stderr while the actual failed
    // RUN step is on stdout. Keep both so the task error identifies its cause.
    const diagnostic =
      [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join("\n").slice(-32_768) ||
      `docker exited with code ${result.code ?? "null"} signal ${result.signal ?? "none"}`;
    throw Object.assign(new DockerEnvironmentError("ENV_PREPARATION_FAILED", diagnostic), { exitCode: result.code, signal: result.signal });
  }
  return output;
}
