import type { Benchmark } from "./benchmark.js";
import type { Environment } from "./environment.js";
import type { Metrics } from "./metrics.js";
import type { Reporter } from "./reporter.js";
import type { RunStore } from "./run-store.js";
import type { TaskScheduler } from "./scheduler.js";
import type { Solver } from "./solver.js";
import type { RunManifest } from "./result.js";

export type RunComponents = {
  benchmark: Benchmark;
  environment: Environment;
  solver: Solver;
  metrics: Metrics[];
  reporter: Reporter;
  store: RunStore;
  scheduler: TaskScheduler;
  pluginVersions: Record<string, string>;
  pluginRuntime?: NonNullable<RunManifest["pluginRuntime"]>;
};
