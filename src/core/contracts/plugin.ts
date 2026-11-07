import type { HardwareKind } from "./hardware.js";
import type { PhaseTimeoutOverrides } from "./task.js";

import type { ModelConfig, RuntimeAuth, Selection } from "./config.js";
import type { Benchmark } from "./benchmark.js";
import type { Environment } from "./environment.js";
import type { Metrics } from "./metrics.js";
import type { Reporter } from "./reporter.js";
import type { RunStore } from "./run-store.js";
import type { TaskScheduler } from "./scheduler.js";
import type { Solver } from "./solver.js";
import type { Verifier } from "./verifier.js";


export type PluginRole = "benchmark" | "environment" | "solver" | "verifier" | "metrics" | "reporter" | "store" | "scheduler";

export type RoleImplementations = {
  benchmark: Benchmark;
  environment: Environment;
  solver: Solver;
  verifier: Verifier;
  metrics: Metrics;
  reporter: Reporter;
  store: RunStore;
  scheduler: TaskScheduler;
};

export type ServiceBinding = { model: ModelConfig; auth: RuntimeAuth };

export type ReportingFactoryContext = {
  configDirectory: string;
  resolvePath(path: string): string;
};

export type FactoryContext<R extends PluginRole> = R extends "metrics" | "reporter" ? ReportingFactoryContext : PluginFactoryContext;

export type PluginFactoryContext = {
  benchmarkName?: string;
  network?: import("./network.js").NetworkAccess;
  /** Bootstrap always supplies this; omitted by historical SDK callers means NPU. */
  hardware?: HardwareKind;
  phaseTimeouts?: PhaseTimeoutOverrides;
  imageConfigFingerprint?: string;
  /** Optional component composed by the Benchmark, owned by the same Cordis context. */
  verifier?: Verifier;
  verifierService?: string;
  /** Nonfatal runtime diagnostics; never include credentials or private task data. */
  onWarning?: (message: string) => void;
  /** All declared services. A solver applies `solverService` from this map. */
  services: Record<string, ServiceBinding>;
  solverService: string;
  /** Execution placement, not a solver-specific user option. */
  environmentName?: string;
  configDirectory: string;
  /** Local patch used to submit this run, when one was explicitly selected. */
  pluginPatchPath?: string;
  resolvePath(path: string): string;
};

export function bindService(runtime: Pick<PluginFactoryContext, "services">, name: string): ServiceBinding {
  const binding = runtime.services[name];
  if (!binding) throw new TypeError(`Component references unavailable service ${name}`);
  return binding;
}

export function bindSolverService(runtime: PluginFactoryContext): ServiceBinding {
  return bindService(runtime, runtime.solverService);
}

export type PluginConfigValidator<T = Record<string, unknown>> = (config: unknown) => T;
export type PluginFactory<R extends PluginRole, T = Record<string, unknown>> = (
  config: T,
  runtime: FactoryContext<R>,
) => RoleImplementations[R] | Promise<RoleImplementations[R]>;

export type PreparedPlugin<R extends PluginRole> = (runtime: FactoryContext<R>) => Promise<RoleImplementations[R]>;
