import type { PreparationCacheSource } from "../../core/contracts/environment.js";
import type { ActivityListener, ComponentActivity } from "../../core/contracts/activity.js";
import { dockerActivity, withDockerActivity } from "./progress.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { applicationCacheRoot } from "../runtime-installation/install.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";

type BuildEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
  listeners: Set<ActivityListener>;
  latest?: ComponentActivity;
};

/** Share successful image builds without making any one attempt their owner. */
export class DockerBuildCache<T> {
  private readonly entries = new Map<string, BuildEntry<T>>();
  /** Transient operations must inspect external state again after completion. */
  constructor(private readonly retainSuccess = true) {}

  /** The callback must inspect Docker again under the lock before building. */
  async getImage(docker: string, image: string, signal: AbortSignal, build: (signal: AbortSignal) => Promise<T>, observe?: (source: PreparationCacheSource) => void): Promise<T> {
    const key = createHash("sha256").update(JSON.stringify([docker, process.env.DOCKER_HOST, process.env.DOCKER_CONTEXT,
      process.env.DOCKER_CONFIG, process.env.DOCKER_TLS_VERIFY, process.env.DOCKER_CERT_PATH, image])).digest("hex");
    const lock = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "image-builds", `${key}.lock`);
    return this.get(lock, signal, async active => {
      const release = await acquireRuntimeLock(lock, active);
      try {
        active.throwIfAborted();
        return await build(active);
      } finally { await release(); }
    }, observe);
  }

  async get(key: string, signal: AbortSignal, build: (signal: AbortSignal) => Promise<T>, observe?: (source: PreparationCacheSource) => void): Promise<T> {
    signal.throwIfAborted();
    let entry = this.entries.get(key);
    const activity = dockerActivity();
    if (entry) observe?.(entry.settled ? "memory" : "shared");
    if (!entry) {
      const controller = new AbortController();
      const created: BuildEntry<T> = {
        controller,
        waiters: 0,
        settled: false,
        listeners: new Set(),
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return withDockerActivity(event => {
            // Do not retain raw build output before each caller's own redaction boundary.
            created.latest = { ...(event.message === undefined ? {} : { message: event.message }), activity: false,
              ...(event.operationId ? { operationId: event.operationId, status: "updated" } : {}) };
            for (const listener of created.listeners) listener(event);
          }, () => build(controller.signal));
        }),
      };
      created.promise = created.promise.then(
        value => {
          created.settled = true;
          if (!this.retainSuccess && this.entries.get(key) === created) this.entries.delete(key);
          return value;
        },
        error => {
          created.settled = true;
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw error;
        },
      );
      this.entries.set(key, created);
      entry = created;
    }
    const current = entry;
    if (activity) {
      current.listeners.add(activity);
      if (current.waiters && !current.settled) activity({ message: "Waiting for a shared image build", activity: false,
        ...(current.latest?.message ? { lines: [current.latest.message] } : {}),
        ...(current.latest?.operationId ? { operationId: current.latest.operationId, status: "updated" } : {}) });
    }
    current.waiters++;
    return await new Promise<T>((resolve, reject) => {
      let waiting = true;
      const release = () => {
        if (!waiting) return false;
        waiting = false;
        signal.removeEventListener("abort", abort);
        current.waiters--;
        if (activity) current.listeners.delete(activity);
        if (current.waiters === 0 && !current.settled) {
          if (this.entries.get(key) === current) this.entries.delete(key);
          current.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (release()) reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      current.promise.then(
        value => {
          if (release()) resolve(value);
        },
        error => {
          if (release()) reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }
}
