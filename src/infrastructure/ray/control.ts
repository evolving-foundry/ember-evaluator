import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { AttemptKey, RemoteAttemptUpdate } from "../../core/contracts/result.js";
import { TransferError } from "../transfer/protocol.js";
import { assertWorkerVersions } from "./protocol.js";
import { parseProgressSnapshot } from "../../core/progress/progress-wire.js";
import { ProgressSnapshots, safeProgress } from "../../core/progress/live-progress.js";
import type { ProgressListener } from "../../core/progress/progress.js";

type State = {
  key: AttemptKey;
  packageDigest: string;
  versions: Record<string, string>;
  nodeId: string | null;
  cancelled: boolean;
  infrastructureCancellation?: boolean;
  lastSeen: number;
  uploading: boolean;
  preparation: boolean;
  progressSeen?: number;
  progressEnded?: boolean;
  progressInterrupted?: boolean;
};
const identity = (key: AttemptKey) => JSON.stringify([key.runId, key.taskId, key.attemptId]);
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some(key => !fields.includes(key))
  )
    throw new TransferError("RAY_PROTOCOL_INVALID", "Invalid Ray control fields");
  return value as Record<string, unknown>;
}
function label(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
    throw new TransferError("RAY_PROTOCOL_INVALID", "Invalid Ray control identity");
}

/** Lives only in coordinator memory. Never include this object in Ray task metadata. */
export class RayControl {
  private readonly attempts = new Map<string, State>();
  private readonly progress = new ProgressSnapshots();
  private readonly progressTimer: ReturnType<typeof setInterval>;
  constructor(
    private readonly services: Record<string, ServiceBinding>,
    private readonly update: (update: RemoteAttemptUpdate) => Promise<void>,
    private readonly onProgress?: ProgressListener,
  ) {
    this.progressTimer = setInterval(() => {
      for (const state of this.attempts.values()) if (state.progressSeen !== undefined && !state.progressEnded && !state.progressInterrupted && Date.now() - state.progressSeen > 10_000) {
        state.progressInterrupted = true;
        try { this.onProgress?.({ phase: "progress", message: "Progress connection interrupted; node heartbeats and evaluation continue independently", transient: true,
          taskId: state.key.taskId, attemptId: state.key.attemptId, connection: "interrupted" }); } catch { /* Presentation only. */ }
      }
    }, 1000);
    this.progressTimer.unref();
  }
  close(): void { clearInterval(this.progressTimer); this.attempts.clear(); }
  /** Result/preparation acknowledgements close stale previews even if the last progress POST was lost. */
  finishProgress(key: AttemptKey, status: "completed" | "failed" | "cancelled"): void {
    const state = this.attempts.get(identity(key));
    if (state) state.progressEnded = true;
    for (const event of this.progress.snapshot()) {
      if (!event.live || event.taskId !== key.taskId || event.attemptId !== key.attemptId || !["started", "updated"].includes(event.live.status)) continue;
      const terminal = { ...event, live: { ...event.live, sequence: event.live.sequence + 1, status } };
      if (this.progress.observe(terminal)) {
        try { this.onProgress?.(terminal); } catch { /* Presentation cannot prevent result handling. */ }
      }
    }
  }
  register(key: AttemptKey, packageDigest: string, versions: Record<string, string>, preparation = false): void {
    if (this.attempts.has(identity(key))) throw new Error("Ray attempt already registered");
    this.attempts.set(identity(key), {
      key: structuredClone(key),
      packageDigest,
      versions: structuredClone(versions),
      nodeId: null,
      cancelled: false,
      lastSeen: Date.now(),
      uploading: false,
      preparation,
    });
  }
  cancel(key: AttemptKey, infrastructure = false): void {
    const state = this.attempts.get(identity(key));
    if (state) { state.cancelled = true; state.infrastructureCancellation = infrastructure; }
  }
  lastSeen(key: AttemptKey): number {
    return this.attempts.get(identity(key))?.lastSeen ?? 0;
  }
  async handle(route: "runtime" | "control" | "progress", input: unknown): Promise<unknown> {
    if (route === "progress") {
      const value = object(input, ["key", "nodeId", "snapshot"]);
      const key = object(value.key, ["runId", "taskId", "attemptId"]);
      Object.values(key).forEach(label); label(value.nodeId);
      const state = this.attempts.get(identity(key as AttemptKey));
      if (!state || state.nodeId === null || state.nodeId !== value.nodeId) throw new TransferError("RAY_PROTOCOL_INVALID", "Progress node handshake is required", 409);
      const snapshot = parseProgressSnapshot(value.snapshot);
      if (state.progressEnded) return { accepted: true };
      state.progressSeen = Date.now();
      state.progressEnded = snapshot.ended === true;
      if (state.progressInterrupted) {
        state.progressInterrupted = false;
        try { this.onProgress?.({ phase: "progress", message: "Progress connection restored", transient: true,
          taskId: state.key.taskId, attemptId: state.key.attemptId, connection: "connected" }); } catch { /* Presentation only. */ }
      }
      const secrets = Object.values(this.services).map(binding => binding.auth.value);
      for (const event of snapshot.events) {
        if (!event.live) continue;
        const safe = safeProgress({ ...event, taskId: state.key.taskId, attemptId: state.key.attemptId,
          live: { ...event.live, id: `${state.key.attemptId}/${event.live.id}`,
            ...(event.live.parentId ? { parentId: `${state.key.attemptId}/${event.live.parentId}` } : {}) } }, secrets);
        // Deduplication is performed by the terminal/cache; observers receive safe identities only.
        if (this.progress.observe(safe)) {
          try { this.onProgress?.(safe); } catch { /* A failed preview cannot reject worker heartbeats. */ }
        }
      }
      return { accepted: true };
    }
    const value = object(
      input,
      route === "runtime"
        ? ["key", "nodeId", "hostname", "packageDigest", "pluginVersions"]
        : ["key", "nodeId", "state"],
    );
    const key = object(value.key, ["runId", "taskId", "attemptId"]);
    Object.values(key).forEach(label);
    label(value.nodeId);
    const state = this.attempts.get(identity(key as AttemptKey));
    if (!state) throw new TransferError("RAY_PROTOCOL_INVALID", "Ray attempt is not registered", 404);
    if (state.nodeId !== null && state.nodeId !== value.nodeId)
      throw new TransferError("RAY_PROTOCOL_INVALID", "Ray attempt belongs to another node", 409);
    if (route === "runtime") {
      if (state.cancelled) throw new TransferError("RUN_CANCELLED", "Ray attempt is cancelled", 409);
      label(value.hostname);
      label(value.packageDigest);
      if (!value.pluginVersions || typeof value.pluginVersions !== "object" || Array.isArray(value.pluginVersions))
        throw new TransferError("RAY_PROTOCOL_INVALID", "Invalid Ray plugin versions");
      Object.values(value.pluginVersions).forEach(label);
      try {
        assertWorkerVersions(
          state.versions,
          value.pluginVersions as Record<string, string>,
          state.packageDigest,
          value.packageDigest,
        );
      } catch (error) {
        throw new TransferError(
          "SOURCE_CHANGED",
          error instanceof Error ? error.message : "Ray version mismatch",
          409,
        );
      }
      if (state.nodeId === null) {
        state.nodeId = value.nodeId;
        if (!state.preparation) await this.update({ key: state.key, state: "running", nodeId: value.nodeId, hostname: value.hostname });
      }
      state.lastSeen = Date.now();
      state.progressSeen ??= Date.now();
      return {
        services: Object.fromEntries(Object.entries(this.services).map(([name, binding]) =>
          [name, { model: structuredClone(binding.model), auth: { value: state.preparation ? "" : binding.auth.value, reference: null } }])),
      };
    }
    if (state.nodeId === null) throw new TransferError("RAY_PROTOCOL_INVALID", "Ray node handshake is required", 409);
    if (!["running", "uploading"].includes(value.state as string))
      throw new TransferError("RAY_PROTOCOL_INVALID", "Invalid Ray worker state");
    state.lastSeen = Date.now();
    if (value.state === "uploading" && state.preparation) throw new TransferError("RAY_PROTOCOL_INVALID", "Preparation cannot upload an attempt");
    if (value.state === "uploading" && !state.uploading) {
      state.uploading = true;
      await this.update({ key: state.key, state: "uploading" });
    }
    return { cancelled: state.cancelled, ...(state.infrastructureCancellation ? { reason: "infrastructure-timeout" } : {}) };
  }
}
