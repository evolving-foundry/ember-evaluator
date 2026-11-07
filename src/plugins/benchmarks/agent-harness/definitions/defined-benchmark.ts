import { planBenchmarkRun } from "../../shared/plan-run.js";
import type { Benchmark } from "../../../../core/contracts/benchmark.js";
import type { PreparedTask, JsonValue, SourceLock, TaskRef } from "../../../../core/contracts/task.js";
import type { EnvironmentSession } from "../../../../core/contracts/environment.js";
import type { SolveResult, VerifyResult } from "../../../../core/contracts/result.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import { textualAnswer } from "./records.js";
import type { DatasetRecordSource } from "../../../../infrastructure/datasets/record-source.js";
import type { BenchmarkDefinition, BenchmarkRecord, BenchmarkDefinitionContext } from "./benchmark-definition.js";
import type { ActivityListener } from "../../../../core/contracts/activity.js";
import { datasetActivity, withDatasetActivity } from "../../../../infrastructure/datasets/activity.js";
import type { VerificationRuntime } from "../../../../core/contracts/verification-runtime.js";

type Loaded = { rows: BenchmarkRecord[]; setup: JsonValue };

export class DefinedBenchmark implements Benchmark {
  readonly verificationRuntime?: VerificationRuntime;
  readonly planRun: NonNullable<Benchmark["planRun"]> = (refs, source, signal, activity) =>
    planBenchmarkRun(this, refs, source, signal,
      { version: "task-preparation-v1", source: "DefinedBenchmark:environment-preparation" }, 600, activity);
  readonly validateSourceOnCompletedResume = true;
  private readonly loaded = new Map<string, Loaded>();

  constructor(
    private readonly definition: BenchmarkDefinition,
    private readonly source: DatasetRecordSource,
    private readonly context: BenchmarkDefinitionContext,
  ) {
    if (definition.verificationRuntime) this.verificationRuntime = definition.verificationRuntime(context);
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock> {
    const lock = await withDatasetActivity(activity, () => this.source.resolve(previous, signal));
    this.loaded.clear();
    return lock;
  }

  private async load(source: SourceLock, signal: AbortSignal): Promise<Loaded> {
    signal.throwIfAborted();
    const key = fingerprintConfig(source as unknown as JsonValue);
    const cached = this.loaded.get(key);
    if (cached) return cached;
    const rows: BenchmarkRecord[] = [];
    for (const selection of this.definition.selections) {
      let last = 0;
      for await (const value of this.source.rows(source, selection, signal)) {
        rows.push({ value, selection });
        if (performance.now() - last >= 200) {
          datasetActivity(`Read ${rows.length} data records`);
          last = performance.now();
        }
      }
    }
    const preparedRows = this.definition.transformRows?.(rows) ?? rows;
    if (preparedRows.length === 0) throw new Error(`${this.definition.name} dataset contains no tasks`);
    const setup = this.definition.loadSetup ? await this.definition.loadSetup(this.source, source, signal) : null;
    const loaded = { rows: preparedRows, setup };
    this.loaded.set(key, loaded);
    return loaded;
  }

  async *enumerate(source: SourceLock, signal: AbortSignal, activity?: ActivityListener): AsyncIterable<TaskRef> {
    const { rows } = await withDatasetActivity(activity, () => this.load(source, signal));
    for (let index = 0; index < rows.length; index++) {
      signal.throwIfAborted();
      yield { id: `test:${index}`, recordKey: index };
    }
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    const index = ref.recordKey;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || ref.id !== `test:${index}`)
      throw new TypeError(`Invalid ${this.definition.name} task reference`);
    const { rows, setup } = await this.load(source, signal);
    const row = rows[index];
    if (!row) throw new RangeError(`${this.definition.name} task reference is out of range`);
    return {
      ...this.definition.prepare(ref.id, row, index, setup),
      solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] },
      verifyEnv: null,
      transfer: null,
    };
  }

  discloseAnswer(task: PreparedTask): JsonValue | null {
    return textualAnswer(task.verification);
  }

  async verify(
    task: PreparedTask,
    result: SolveResult,
    _session: EnvironmentSession | null,
    signal: AbortSignal,
  ): Promise<VerifyResult> {
    signal.throwIfAborted();
    return this.definition.verify(
      task.verification,
      result.finalText,
      this.context,
      signal,
      result.observations,
    );
  }
}
