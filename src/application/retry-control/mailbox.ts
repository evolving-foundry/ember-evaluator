import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { callControlChannel, openControlChannel } from "../../infrastructure/ipc/control-channel.js";

import type { RetryRequest, RetryInput, RetryAdmission, RetryAdmit, RetryController } from "../../core/contracts/retry-control.js";
type State = { accepting: boolean; pid: number; host: string; requests: RetryRequest[]; recoveryJobId?: string; endpoint?: string };
type Submission = { active: boolean; request: RetryRequest };
type CoordinatorOwner = Pick<State, "pid" | "host" | "endpoint" | "recoveryJobId">;
import { atomic, fileRetry } from "../../infrastructure/filesystem/atomic-json.js";
import { safeId } from "../../infrastructure/filesystem/run-index.js";
/** A short-lived mailbox lock serializes admission with coordinator shutdown. */
export async function controlTransaction<T>(directory: string, operation: (state: State) => Promise<T>,
  options: { afterCommit?: () => void; onCleanupError?: (error: unknown) => void; signal?: AbortSignal } = {}): Promise<T> {
  const lockPath = join(directory, ".retry-control.lock");
  let lock;
  const deadline = Date.now() + 30_000;
  while (!lock) {
    options.signal?.throwIfAborted();
    try {
      lock = await fileRetry(() => open(lockPath, "wx", 0o600));
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    } catch (error) {
      if (lock) { await lock.close(); await fileRetry(() => rm(lockPath, { force: true })); throw error; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
      let owner: unknown;
      try { owner = JSON.parse(await fileRetry(() => readFile(lockPath, "utf8"))); }
      catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(20, undefined, { signal: options.signal }); continue;
      }
      if (owner && typeof owner === "object" && "host" in owner && owner.host === hostname() && "pid" in owner && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 1) {
        try { process.kill(owner.pid, 0); }
        catch (dead) {
          if ((dead as NodeJS.ErrnoException).code !== "ESRCH") throw dead;
          // A directory guard prevents two contenders from deleting each other's recovered lock.
          const guard = `${lockPath}.recovery`;
          try {
            await mkdir(guard);
            try { if (await readFile(lockPath, "utf8") === JSON.stringify(owner)) await fileRetry(() => rm(lockPath)); }
            finally { await rm(guard, { recursive: true }); }
          } catch (recovery) { if (!["EEXIST", "ENOENT"].includes((recovery as NodeJS.ErrnoException).code ?? "")) throw recovery; }
        }
      }
      await delay(20, undefined, { signal: options.signal });
    }
  }
  let failed = true;
  try {
    let state: State;
    let missing = false;
    try { state = JSON.parse(await fileRetry(() => readFile(join(directory, "retry-control.json"), "utf8"))) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; state = { accepting: false, pid: process.pid, host: hostname(), requests: [] }; }
    if (!Array.isArray(state.requests) || typeof state.accepting !== "boolean") throw new Error("Invalid retry control mailbox");
    const before = JSON.stringify(state);
    const result = await operation(state);
    options.signal?.throwIfAborted();
    if (missing || JSON.stringify(state) !== before) await atomic(join(directory, "retry-control.json"), state);
    options.afterCommit?.();
    failed = false;
    return result;
  } finally {
    try { await lock.close(); await fileRetry(() => rm(lockPath, { force: true })); }
    catch (error) {
      if (options.onCleanupError) options.onCleanupError(error);
      else if (!failed) throw error;
    }
  }
}
function normalizeInput(input: unknown): Required<RetryInput> {
  if (!input || typeof input !== "object" || !("taskIds" in input) || !Array.isArray(input.taskIds) ||
    input.taskIds.some((id: unknown) => typeof id !== "string" || id.length === 0 || id.length > 4096)) throw new TypeError("Invalid task selection");
  const requestId = "requestId" in input ? input.requestId : randomUUID();
  if (typeof requestId !== "string") throw new TypeError("Invalid request ID");
  const reason = "reason" in input ? input.reason : "manual network recovery";
  if (typeof reason !== "string") throw new TypeError("Invalid retry reason");
  return { requestId: safeId(requestId), taskIds: [...new Set<string>(input.taskIds)].sort(), reason: reason.slice(0, 2048) };
}
function appendRequest(state: State, input: Required<RetryInput>): RetryRequest {
  const previous = state.requests.find(item => item.requestId === input.requestId);
  if (previous) {
    if (JSON.stringify(previous.taskIds) !== JSON.stringify(input.taskIds)) throw new Error("Request ID reused with another selection");
    return previous;
  }
  const request: RetryRequest = { ...input, status: "pending", bindings: {} };
  state.requests.push(request);
  return request;
}
export async function submitRetry(directory: string, input: RetryInput,
  options: { stoppedCoordinator?: CoordinatorOwner; requireActive?: boolean; signal?: AbortSignal } = {}): Promise<Submission> {
  const normalized = normalizeInput(input);
  try {
    const target = await controlTransaction(directory, async state => {
      const stopped = options.stoppedCoordinator;
      // A Ray status lookup may race a newly started recovery coordinator.
      const sameStoppedOwner = stopped && stopped.pid === state.pid && stopped.host === state.host &&
        stopped.endpoint === state.endpoint && stopped.recoveryJobId === state.recoveryJobId;
      let active = state.accepting && !sameStoppedOwner;
      if (active && state.host === hostname()) {
        try { process.kill(state.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; active = false; }
      }
      if (active) {
        if (!state.endpoint) throw new Error("Active coordinator has no retry IPC endpoint; restart it with the current version");
        return { endpoint: state.endpoint };
      }
      if (options.requireActive) throw new Error("Coordinator retry control is unavailable; resubmit the same request ID when it is ready or has ended");
      state.accepting = false;
      delete state.endpoint;
      return { submission: { active: false, request: structuredClone(appendRequest(state, normalized)) } };
    }, { ...(options.signal ? { signal: options.signal } : {}) });
    if (target.submission) return target.submission;
    const receipt = await callControlChannel(target.endpoint, normalized, options.signal);
    if (!receipt || typeof receipt !== "object" || !("active" in receipt) || receipt.active !== true ||
      !("request" in receipt) || !receipt.request || typeof receipt.request !== "object" ||
      !("requestId" in receipt.request) || receipt.request.requestId !== normalized.requestId) throw new Error("Invalid retry receipt");
    const request = receipt.request;
    if (!("status" in request) || (request.status !== "pending" && request.status !== "accepted" && request.status !== "completed" && request.status !== "rejected") ||
      !("reason" in request) || typeof request.reason !== "string" || !("taskIds" in request) || JSON.stringify(request.taskIds) !== JSON.stringify(normalized.taskIds) ||
      !("bindings" in request) || !request.bindings || typeof request.bindings !== "object" || Array.isArray(request.bindings)) throw new Error("Invalid retry receipt");
    const bindings: [string, string][] = [];
    for (const [taskId, attemptId] of Object.entries(request.bindings)) {
      if (typeof attemptId !== "string") throw new Error("Invalid retry receipt");
      bindings.push([taskId, attemptId]);
    }
    return { active: true, request: { ...normalized, reason: request.reason, status: request.status, bindings: Object.fromEntries(bindings),
      ...("message" in request && typeof request.message === "string" ? { message: request.message } : {}) } };
  } catch (error) {
    throw new Error(`Retry request ${normalized.requestId} was not confirmed. Resubmit the same request ID; do not generate a new ID. ${error instanceof Error ? error.message : "IPC failed"}`, { cause: error });
  }
}

export class RetryControl implements RetryController {
  private accepting = true;
  private admit: RetryAdmit | undefined;
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private constructor(private readonly directory: string,
    private readonly channel: Awaited<ReturnType<typeof openControlChannel>>,
    private readonly warn: (error: unknown) => void) {}

  static async start(directory: string, warn: (error: unknown) => void): Promise<RetryControl> {
    let control: RetryControl;
    const channel = await openControlChannel(input => control.receive(normalizeInput(input)), warn);
    control = new RetryControl(directory, channel, warn);
    try {
      await controlTransaction(directory, async state => {
        state.accepting = true; state.pid = process.pid; state.host = hostname(); state.endpoint = channel.endpoint;
      }, { onCleanupError: warn });
      return control;
    } catch (error) { await channel.close(); throw error; }
  }
  async setAdmission(admit: RetryAdmit): Promise<void> {
    this.admit = admit;
    // Requests received during source/environment preparation were acknowledged as pending.
    await this.receive();
  }
  private async receive(input?: Required<RetryInput>): Promise<Submission | undefined> {
    let admission: RetryAdmission | undefined;
    try {
      return await controlTransaction(this.directory, async state => {
        if (!this.accepting || !state.accepting || state.endpoint !== this.channel.endpoint)
          throw new Error("Retry coordinator is closing; resubmit the same request ID after it ends");
        const request = input ? appendRequest(state, input) : undefined;
        const pending = request ? request.status === "pending" ? [request] : [] : state.requests.filter(item => item.status === "pending");
        if (pending.length && this.admit) admission = await this.admit(pending);
        return request ? { active: true, request: structuredClone(request) } : undefined;
      }, { afterCommit: () => admission?.commit(), onCleanupError: this.warn });
    } finally { admission?.release(); }
  }
  stopAccepting(): Promise<void> {
    this.accepting = false;
    return this.stopping ??= this.finish();
  }
  private async finish(): Promise<void> {
    try {
      await controlTransaction(this.directory, async state => {
        state.accepting = false;
        delete state.endpoint;
        for (const request of state.requests) {
          if (request.status === "accepted") request.status = "completed";
          else if (request.status === "pending") { request.status = "rejected"; request.message = "Coordinator ended before admission"; }
        }
      }, { onCleanupError: this.warn });
    } catch (error) { this.warn(error); }
  }
  close(): Promise<void> {
    return this.closing ??= this.stopAccepting().then(() => this.channel.close());
  }
}
