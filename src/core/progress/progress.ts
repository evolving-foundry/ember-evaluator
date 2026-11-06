import type { Failure } from "../contracts/result.js";

export type LiveProgress = {
  id: string;
  parentId?: string;
  sequence: number;
  status: "started" | "updated" | "completed" | "failed" | "cancelled";
  elapsedMs: number;
  idleMs: number;
  lines: string[];
  /** Completion makes this task's execution environment ready. */
  preparation?: boolean;
};

/** Optional coordinator/local-attempt diagnostics. */
export type ProgressEvent = {
  phase: string;
  message: string;
  taskId?: string;
  attemptId?: string;
  taskNumber?: number;
  taskTotal?: number;
  error?: boolean;
  warning?: boolean;
  failure?: Failure;
  /** Presentation-only observations; must not be persisted as experiment evidence. */
  transient?: boolean;
  live?: LiveProgress;
  summary?: { total: number; prepared: number; completed: number };
  connection?: "connected" | "interrupted" | "unsupported";
};

export type ProgressListener = (event: ProgressEvent) => void;
