import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { EnvironmentSpec } from "../../core/contracts/environment.js";
import type { DockerCommand } from "./runtime-contract.js";

/** Run after Compose health/dependency startup, rather than replacing main's dependency gate. */
export async function waitTaskHealth(command: DockerCommand, id: string, health: NonNullable<EnvironmentSpec["healthcheck"]>, signal: AbortSignal): Promise<void> {
  const started = performance.now();
  let failures = 0;
  let last: unknown;
  while (failures < health.retries) {
    signal.throwIfAborted();
    try {
      await command(["exec", id, "sh", "-c", health.command], { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(health.timeoutSeconds * 1000))]) });
      return;
    } catch (cause) { signal.throwIfAborted(); last = cause; }
    const inGrace = performance.now() - started < health.startPeriodSeconds * 1000;
    if (!inGrace) failures++;
    if (failures < health.retries) await delay((inGrace ? health.startIntervalSeconds : health.intervalSeconds) * 1000, undefined, { signal });
  }
  throw new Error(`Task healthcheck failed after ${health.retries} attempts`, { cause: last });
}
