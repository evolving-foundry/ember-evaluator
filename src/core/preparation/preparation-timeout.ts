import type { PreparationStageTiming } from "../contracts/result.js";
import { PhaseTimeoutError } from "../policies/phase-timeout.js";
import { declaredErrorCode } from "../errors/classify.js";
import { ERROR_CODES } from "../errors/registry.js";

export const DEFAULT_PREPARATION_TIMEOUT_SECONDS = 600;

export function preparationConcurrency(configured: number, taskCount: number, slots = configured): number {
  if (!Number.isSafeInteger(configured) || configured < 1 || !Number.isSafeInteger(slots) || slots < 1)
    throw new TypeError("Invalid preparation concurrency");
  return Math.max(1, Math.min(configured, taskCount, slots));
}

export function preparationTimeoutMs(seconds: number, label = "Preparation timeout"): number {
  const ms = Math.ceil(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || ms > 2_147_483_647)
    throw new TypeError(`${label} must be positive and fit within 2147483647 milliseconds`);
  return ms;
}

/** Time only admitted work; callers retain and drain operations after cancellation. */
export async function withPreparationTimeout<T>(
  purpose: "solve" | "verify", baseSeconds: number, concurrency: number, signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>, observe?: (timing: PreparationStageTiming) => void,
  elapsedMs = 0,
): Promise<T> {
  preparationConcurrency(concurrency, concurrency);
  preparationTimeoutMs(baseSeconds);
  const multiplier = Math.min(concurrency, 10);
  const timeoutSeconds = baseSeconds * multiplier;
  const ms = preparationTimeoutMs(timeoutSeconds) - Math.ceil(elapsedMs);
  signal.throwIfAborted();
  const started = Date.now();
  const timing: PreparationStageTiming = { baseSeconds, concurrency, multiplier, timeoutSeconds,
    startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + Math.max(0, ms)).toISOString(), finishedAt: null,
    ...(elapsedMs > 0 ? { elapsedMs } : {}) };
  observe?.(timing);
  const controller = new AbortController();
  const reason = () => new PhaseTimeoutError("environment",
    `${purpose} environment preparation exceeded ${timeoutSeconds}s (base ${baseSeconds}s × ${multiplier}; concurrency ${concurrency})`);
  const timer = setTimeout(() => controller.abort(reason()), Math.max(0, ms));
  timer.unref();
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    if (ms <= 0) controller.abort(reason());
    combined.throwIfAborted();
    const result = await work(combined);
    combined.throwIfAborted();
    return result;
  } catch (error) {
    // Adapters often throw AbortError instead of the structured timeout reason.
    if (combined.aborted) {
      const code = declaredErrorCode(error);
      if (code && ["abort_run", "stop_dispatch"].includes(ERROR_CODES[code].action)) throw error;
      throw combined.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    timing.finishedAt = new Date().toISOString();
  }
}
