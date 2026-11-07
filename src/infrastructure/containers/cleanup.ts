import type { ErrorCode } from "../../core/errors/registry.js";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { DockerCommand } from "./runtime-contract.js";

export const CONTAINER_STOP_GRACE_SECONDS = "2";

/** A lost stop reply is not evidence that the namespace is still running. */
export async function stopDockerContainer(
  command: DockerCommand,
  id: string,
  signal: AbortSignal,
  limits: { commandMs?: number; inspectMs?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const failures: unknown[] = [];
  const budget = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  for (let index = 0; index < 3; index++) {
    signal.throwIfAborted();
    try {
      await command(["stop", "--time", CONTAINER_STOP_GRACE_SECONDS, id], {
        signal: AbortSignal.any([budget, AbortSignal.timeout(limits.commandMs ?? 10_000)]),
      });
      return;
    } catch (error) { failures.push(error); }
    signal.throwIfAborted();
    try {
      const response = await command(["container", "inspect", id, "--format", "{{json .State}}"], {
        signal: AbortSignal.any([budget, AbortSignal.timeout(limits.inspectMs ?? 3_000)]),
      });
      const state: unknown = JSON.parse(response.stdout);
      if (state !== null && typeof state === "object" && "Running" in state && state.Running === false
        && "Pid" in state && state.Pid === 0 && "Status" in state && state.Status === "exited") return;
    } catch (error) { failures.push(error); }
    if (budget.aborted) break;
    if (index < 2) await delay(limits.retryDelayMs ?? 1_000, undefined, { signal: budget });
  }
  signal.throwIfAborted();
  throw new DockerCleanupError(`Cannot confirm stopped state of Docker container ${id}`, { cause: new AggregateError(failures) });
}

class DockerCleanupError extends Error {
  readonly code: ErrorCode = "CLEANUP_FAILED";
}

function missingContainer(error: unknown): boolean {
  return error instanceof Error && /No such (?:container|object):/iu.test(error.message);
}

async function attempt(
  command: DockerCommand,
  args: string[],
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  const started = performance.now();
  try {
    await command(args, { signal });
  } catch (cause) {
    if (missingContainer(cause)) return;
    throw new Error(`${label} failed after ${Math.round(performance.now() - started)}ms`, { cause });
  }
}

/** Reconcile daemon state before treating a slow CLI response as a leaked session. */
export async function removeDockerContainer(
  command: DockerCommand,
  id: string,
  signal: AbortSignal,
  limits: { commandMs?: number; inspectMs?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const commandMs = limits.commandMs ?? 10_000;
  const inspectMs = limits.inspectMs ?? 3_000;
  const retryDelayMs = limits.retryDelayMs ?? 5_000;
  const failures: unknown[] = [];
  signal.throwIfAborted();
  // Leave the task's default 60s disposal budget enough time to publish a
  // contextual error instead of racing that outer deadline. A daemon removal
  // already in progress needs time to settle, not three immediate retries.
  const cleanupSignal = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  const failed = () => new DockerCleanupError(`Cannot confirm removal of Docker container ${id}`, {
    cause: new AggregateError(failures),
  });
  try {
    // Give PID 1 a chance to exit before Docker falls back to SIGKILL. A stopped
    // namespace is still the boundary, including writers outside tracked groups.
    await attempt(command, ["stop", "--time", CONTAINER_STOP_GRACE_SECONDS, id], cleanupSignal, Math.min(commandMs, 5_000), `stop container ${id}`);
  } catch (error) {
    failures.push(error);
  }
  for (let index = 0; index < 8; index++) {
    signal.throwIfAborted();
    if (cleanupSignal.aborted) throw failed();
    try {
      await attempt(command, ["rm", "--force", id], cleanupSignal, commandMs, `remove container ${id}`);
      return;
    } catch (error) {
      failures.push(error);
    }
    signal.throwIfAborted();
    if (cleanupSignal.aborted) throw failed();
    try {
      await command(["container", "inspect", id, "--format", "{{.Id}}"], {
        signal: AbortSignal.any([cleanupSignal, AbortSignal.timeout(inspectMs)]),
      });
    } catch (error) {
      // Only an explicit NotFound is confirmation. Connection errors, timeouts,
      // and a container still marked removing must never count as cleanup.
      if (missingContainer(error)) return;
      failures.push(new Error(`confirm removal of container ${id} failed`, { cause: error }));
    }
    if (index < 7) {
      try { await delay(retryDelayMs, undefined, { signal: cleanupSignal }); }
      catch (error) { signal.throwIfAborted(); failures.push(error); throw failed(); }
    }
  }
  throw failed();
}
