import type { HardwareKind } from "./hardware.js";
import type { JsonValue, PhaseTimeoutOverrides } from "./task.js";

export type CliOverrides = {
  model?: string;
  endpoint?: string;
  apiKey?: string;
  apiKeyEnv?: string;
};

export type ModelConfig = {
  name: string;
  endpoint: string | null;
  provider: string | null;
  api: string | null;
  /** Per-response ceiling; custom OpenAI Chat Completions omits the wire limit when unset. */
  maxTokens?: number;
  /** Input context threshold for automatic compaction, independent of output length. */
  contextWindow?: number;
  /** Model-call retry budget; absent values keep the default of 4 attempts. */
  retry?: { maxAttempts: number };
};

export type Selection = {
  name: string;
  config: Record<string, unknown>;
};

/** Solver selection plus the named entry in top-level `services` it should run. */
export type SolverSelection = Selection & { service: string };
export type VerifierSelection = Selection & { service?: string };

export type EffectiveConfig = {
  /** Defaults to NPU for existing callers and saved configurations. */
  hardware?: HardwareKind;
  /** Every declared model service. Callers bind the one they reference. */
  services: Record<string, ModelConfig>;
  benchmark: Selection;
  verifier?: VerifierSelection;
  environment: Selection;
  solver: SolverSelection;
  metrics: Selection[];
  reporter: Selection;
  store: Selection;
  scheduler: Selection;
  run: PhaseTimeoutOverrides & {
    maxTasks: number | null;
    /** Skip this many candidates after taskIds filtering and optional shuffling; absent means 0. */
    offset?: number;
    taskIds: string[] | null;
    timeoutSeconds: number;
    sampling?: { strategy: "random"; seed: number };
    /** Absent means "abort": failed/invalid tasks stop the run; valid Agent deadlines can refill the slot. */
    onError?: "abort" | "continue";
    /** Absent or false omits the original prompt and textual answer from each result. */
    includeTaskAnswer?: boolean;
    /** Local preparation defaults to pipeline, with preparation concurrency matching execution. */
    preparation?: { mode: "batch" | "pipeline"; concurrency: number; lookahead?: number;
      environmentTimeoutSeconds?: number; roundTimeoutSeconds?: number };
  };
  output: { directory: string };
};

export type RuntimeAuth = {
  value: string;
  reference: string | null;
};

export type ExecutionConfig = {
  /** User-selected profile name, before expansion to an implementation such as harbor. */
  benchmarkName?: string;
  network?: import("./network.js").NetworkDocument;
  experiment: EffectiveConfig;
  /** Secrets for services whose credentials were resolved. The solver's service is always present. */
  auths: Record<string, RuntimeAuth>;
  persisted: JsonValue;
  /** Explanations only; excluded from persisted configuration and resume fingerprints. */
  resolution?: { origins: Record<string, string> };
};
