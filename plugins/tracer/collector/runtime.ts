/** Process-wide runtime state shared by every collector module. */
import type { IncomingMessage } from "node:http";
import type { TraceStore } from "./trace-store.js";

export interface Cfg {
  host: string;
  port: number;
  view: string;
  token: string;
  maxQueue: number;
  maxBody: number;
  workers: number;
  sampleRate: number;
  maxBatches: number;
  maxSeen: number;
  subQueue: number;
  db: string;
  spool: string;
  shutdownTimeout: number;
  replayMax: number;
  retentionDays: number;
  retentionInterval: number;
}

/** Bounded FIFO whose consumers await new items instead of polling. */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T) => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  /** Enqueues an item; returns false when the queue is full. */
  push(item: T): boolean {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(item);
      return true;
    }
    if (this.items.length >= this.capacity) return false;
    this.items.push(item);
    return true;
  }

  async shift(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return undefined;
    return new Promise<T | undefined>(resolve => {
      this.waiters.push(resolve as (item: T) => void);
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      (waiter as unknown as (item: T | undefined) => void)(undefined);
    }
  }
}

export interface Subscriber {
  /** Returns false when the subscriber's backlog is full and the event was dropped. */
  push(event: unknown): boolean;
  close(): void;
}

/** Fixed-capacity FIFO used for in-memory replay batches. */
export class BoundedDeque<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  toArray(): T[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }
}

export interface Batch {
  seq: number | null;
  kind: string;
  data: unknown;
  at: number;
}

export interface Session {
  id: string;
  kind: string;
  count: number;
  firstAt: number;
  updatedAt: number;
  epoch: string | null;
  stats: unknown;
  batches: BoundedDeque<Batch>;
}

export interface Metrics {
  received_lines: number;
  accepted: number;
  deduped: number;
  sampled_drop: number;
  rejected_429: number;
  bad_lines: number;
  broadcasts: number;
  unknown_kind_lines: number;
  unknown_format_lines: number;
  processing_errors: number;
  dead_letter_lines: number;
  db_errors: number;
  events_accepted: number;
  unknown_event_lines: number;
  outcomes_accepted: number;
  sse_dropped: number;
  retention_purged_epochs: number;
}

export class State {
  readonly queue: AsyncQueue<string>;
  readonly sessions = new Map<string, Session>();
  readonly seen = new Map<string, Set<string>>();
  readonly subscribers = new Set<Subscriber>();
  readonly queued = new Set<string>();
  stopping = false;
  readonly metrics: Metrics = {
    received_lines: 0,
    accepted: 0,
    deduped: 0,
    sampled_drop: 0,
    rejected_429: 0,
    bad_lines: 0,
    broadcasts: 0,
    unknown_kind_lines: 0,
    unknown_format_lines: 0,
    processing_errors: 0,
    dead_letter_lines: 0,
    db_errors: 0,
    events_accepted: 0,
    unknown_event_lines: 0,
    outcomes_accepted: 0,
    sse_dropped: 0,
    retention_purged_epochs: 0,
  };

  constructor(readonly cfg: Cfg) {
    this.queue = new AsyncQueue<string>(cfg.maxQueue);
  }
}

/** Mutable container so modules can share cfg/state/store without rebinding imports. */
class Runtime {
  cfg!: Cfg;
  st!: State;
  store: TraceStore | null = null;

  /** Store accessor for callers that already answered 503 when persistence is disabled. */
  get db(): TraceStore {
    if (this.store === null) throw new Error("store disabled");
    return this.store;
  }

  start(cfg: Cfg, state: State, store: TraceStore | null): void {
    this.cfg = cfg;
    this.st = state;
    this.store = store;
  }
}

export const RT = new Runtime();

export function authorized(req: IncomingMessage): boolean {
  if (!RT.cfg.token) return true;
  return req.headers.authorization === `Bearer ${RT.cfg.token}`;
}
