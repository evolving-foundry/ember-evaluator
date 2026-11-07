import { validFailureMetadata } from "../errors/validation.js";

function failure(value: unknown): boolean {
  return value === undefined || object(value) && typeof value.code === "string" && typeof value.message === "string" &&
    value.phase === "prepare" && validFailureMetadata(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function duration(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function validPreparationBudget(value: Record<string, unknown>): boolean {
  if (value.timeoutPolicy !== undefined && value.timeoutPolicy !== "task-concurrency-v1") return false;
  if (value.budgetSeconds === null)
    return value.timeoutPolicy === "task-concurrency-v1" && value.deadlineAt === null;
  return typeof value.budgetSeconds === "number" && Number.isFinite(value.budgetSeconds) && value.budgetSeconds > 0 &&
    (value.deadlineAt === null ? value.timeoutPolicy === "task-concurrency-v1" && value.mode === "pipeline"
      : timestamp(value.deadlineAt) && timestamp(value.startedAt) && Date.parse(String(value.deadlineAt)) > Date.parse(String(value.startedAt)));
}

export function assertEnvironmentTimeouts(value: unknown): void {
  if (value === undefined) return;
  if (!object(value) || !Object.entries(value).every(([phase, timing]) =>
    ["solve", "verify"].includes(phase) && object(timing) &&
    typeof timing.baseSeconds === "number" && Number.isFinite(timing.baseSeconds) && timing.baseSeconds > 0 &&
    positiveInteger(timing.concurrency) && timing.multiplier === Math.min(Number(timing.concurrency), 10) &&
    timing.timeoutSeconds === timing.baseSeconds * Number(timing.multiplier) &&
    Number(timing.timeoutSeconds) * 1000 <= 2_147_483_647 &&
    timestamp(timing.startedAt) && timestamp(timing.deadlineAt) &&
    (timing.elapsedMs === undefined || duration(timing.elapsedMs)) &&
    Date.parse(String(timing.deadlineAt)) - Date.parse(String(timing.startedAt)) ===
      Math.max(0, Math.ceil(Number(timing.timeoutSeconds) * 1000) - Math.ceil(Number(timing.elapsedMs ?? 0))) &&
    (timing.finishedAt === null || timestamp(timing.finishedAt))))
    throw new TypeError("Invalid environment preparation timeout evidence");
}
function imageTiming(value: unknown): boolean {
  if (!object(value) || !["imageMs", "runtimeMs", "solverMs"].every(key => duration(value[key]))) return false;
  if (value.cache === undefined) return true;
  return object(value.cache) && Object.entries(value.cache).every(([key, source]) =>
    ["image", "runtime", "solver"].includes(key) && typeof source === "string" &&
    ["memory", "shared", "image", "built", "reference"].includes(source));
}

/** Optional diagnostics remain compatible with historical batch manifests. */
export function assertPreparationDiagnostics(value: unknown): void {
  if (!object(value)) throw new TypeError("Invalid preparation diagnostics");
  if (!failure(value.failure)) throw new TypeError("Invalid preparation failure");
  if (value.nodeConcurrency !== undefined && (!object(value.nodeConcurrency) ||
    !Object.values(value.nodeConcurrency).every(positiveInteger))) throw new TypeError("Invalid node preparation concurrency");
  if ((value.mode !== undefined && value.mode !== "batch" && value.mode !== "pipeline") ||
    (value.concurrency !== undefined && !positiveInteger(value.concurrency)) ||
    (value.lookahead !== undefined && (!positiveInteger(value.lookahead) ||
      (typeof value.concurrency === "number" && Number(value.lookahead) < value.concurrency))))
    throw new TypeError("Invalid preparation limits");
  if (value.tasks === undefined) return;
  if (!Array.isArray(value.tasks) || !Array.isArray(value.taskIds) || value.tasks.length !== value.taskIds.length)
    throw new TypeError("Invalid preparation task timings");
  const seen = new Set<string>();
  for (const task of value.tasks) {
    if (object(task)) assertEnvironmentTimeouts(task.environmentTimeouts);
    if (!object(task) || typeof task.taskId !== "string" || !value.taskIds.includes(task.taskId) || seen.has(task.taskId) ||
      typeof task.status !== "string" || !["queued", "preparing", "ready", "error", "cancelled"].includes(task.status) ||
      !timestamp(task.queuedAt) || (task.startedAt !== null && !timestamp(task.startedAt)) ||
      (task.finishedAt !== null && !timestamp(task.finishedAt)) ||
      (task.queueDurationMs !== null && !duration(task.queueDurationMs)) ||
      (task.durationMs !== null && !duration(task.durationMs)) ||
      !object(task.phaseDurationMs) || !Object.entries(task.phaseDurationMs).every(([key, elapsed]) =>
        ["solveEnvironment", "verifyEnvironment"].includes(key) && duration(elapsed)) ||
      (task.error !== undefined && typeof task.error !== "string") ||
      !failure(task.failure) ||
      (task.status === "ready" && (task.startedAt === null || task.finishedAt === null || task.durationMs === null || task.queueDurationMs === null)) ||
      (task.imagePhaseDurationMs !== undefined && (!object(task.imagePhaseDurationMs) ||
        !Object.entries(task.imagePhaseDurationMs).every(([phase, timing]) => ["solve", "verify"].includes(phase) && imageTiming(timing)))))
      throw new TypeError("Invalid preparation task timing");
    seen.add(task.taskId);
  }
}
