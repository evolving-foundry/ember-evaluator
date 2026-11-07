import { join, resolve } from "node:path";
import { formatError } from "../core/errors/diagnostics.js";
import { rebuildReport } from "./report/index.js";
import { executeExperiment, type EvaluationResult, type EvaluatorRunOptions } from "./run.js";

export type { EvaluationResult, EvaluatorRunOptions } from "./run.js";

/** A failed application operation, possibly with a persisted partial run. */
export class EvaluatorRunError extends Error {
  constructor(
    message: string,
    readonly phase: string,
    readonly exitCode: number,
    readonly result: EvaluationResult | null,
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EvaluatorRunError";
  }
}

/** Each call owns its registry and resources; instances hold no process-wide state. */
export class Evaluator {
  async run(options: EvaluatorRunOptions): Promise<EvaluationResult> {
    const outcome = await executeExperiment(options);
    if (outcome.diagnostics.length || !outcome.result) {
      const first = outcome.diagnostics[0];
      const causes = outcome.diagnostics.map(item => new Error(formatError(item.error, outcome.secrets)));
      throw new EvaluatorRunError(causes[0]?.message ?? "Evaluation did not create a run",
        first?.phase ?? "config", outcome.exitCode, outcome.result,
        { cause: causes.length === 1 ? causes[0] : new AggregateError(causes, "Evaluation operation failed") });
    }
    return outcome.result;
  }

  async report(runDirectory: string): Promise<string> {
    const directory = resolve(runDirectory);
    await rebuildReport(directory);
    return join(directory, "report.md");
  }
}
