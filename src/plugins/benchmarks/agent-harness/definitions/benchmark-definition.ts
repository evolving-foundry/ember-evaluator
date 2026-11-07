import type { PreparedTask, JsonValue, SourceLock } from "../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../core/contracts/result.js";
import type { ModelConfig, RuntimeAuth } from "../../../../core/contracts/config.js";
import type { DatasetRecordSource } from "../../../../infrastructure/datasets/record-source.js";
import type { VerificationRuntime } from "../../../../core/contracts/verification-runtime.js";

export type BenchmarkRecord = { value: JsonValue; selection: string };
export type BenchmarkDefinitionContext = {
  network?: import("../../../../core/contracts/network.js").NetworkAccess | undefined;
  judge?: { model: ModelConfig; auth: RuntimeAuth };
  judgeService?: string;
  dockerExecutable: string;
};
export type DefinedTask = Pick<PreparedTask, "input" | "verification">;

/** Evaluator-owned task conversion and scoring, independent of the download source. */
export type BenchmarkDefinition = {
  name: string;
  selections: readonly string[];
  verificationRuntime?: (context: BenchmarkDefinitionContext) => VerificationRuntime;
  transformRows?: (rows: BenchmarkRecord[]) => BenchmarkRecord[];
  loadSetup?: (source: DatasetRecordSource, lock: SourceLock, signal: AbortSignal) => Promise<JsonValue>;
  prepare: (id: string, row: BenchmarkRecord, index: number, setup: JsonValue) => DefinedTask;
  verify: (
    verification: JsonValue,
    response: string,
    context: BenchmarkDefinitionContext,
    signal: AbortSignal,
    /** Versioned solver evidence, e.g. candidate token log probabilities. */
    observations?: JsonValue,
  ) => VerifyResult | Promise<VerifyResult>;
};
