import type { StoreDecoratorFactory } from "./contracts/plugin-extension.js";
import type { HardwareKind } from "./contracts/hardware.js";
import type { PhaseTimeoutOverrides } from "./contracts/task.js";
import { Service, type Context } from "@deepseek-ai/cordis";

import type { ModelConfig, RuntimeAuth, Selection } from "../config/schema.js";
import type { Benchmark } from "./contracts/benchmark.js";
import type { Environment } from "./contracts/environment.js";
import type { Metrics } from "./contracts/metrics.js";
import type { Reporter } from "./contracts/reporter.js";
import type { RunStore } from "./contracts/run-store.js";
import type { TaskScheduler } from "./contracts/scheduler.js";
import type { Solver } from "./contracts/solver.js";
import type { Verifier } from "./contracts/verifier.js";
import { parseConfigProfile, type ConfigProfile } from "../config/profiles.js";
import type { PluginConfigTransport } from "./contracts/config-transport.js";

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
  signal?: AbortSignal;
  benchmarkName?: string;
  network?: import("./contracts/network.js").NetworkAccess;
  /** Bootstrap always supplies this; omitted by historical SDK callers means NPU. */
  hardware?: HardwareKind;
  phaseTimeouts?: PhaseTimeoutOverrides;
  imageConfigFingerprint?: string;
  /** Optional component composed by the Benchmark, owned by the same Cordis context. */
  verifier?: Verifier;
  verifierService?: string;
  /** Nonfatal runtime diagnostics; never include credentials or private task data. */
  onWarning?: (message: string, level?: "info" | "warning") => void;
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

type Registration<R extends PluginRole = PluginRole> = {
  role: R;
  name: string;
  validate: PluginConfigValidator<unknown>;
  factory: PluginFactory<R, unknown>;
  transport?: PluginConfigTransport;
};

declare module "@deepseek-ai/cordis" {
  interface Context {
    evaluator: EvaluatorRegistry;
  }
}

export class EvaluatorRegistry extends Service {
  protected readonly registrations = new Map<string, Registration>();
  private readonly storeDecorators = new Map<string, { validate: PluginConfigValidator<unknown>; factory: StoreDecoratorFactory<unknown> }>();
  private readonly profileRegistrations = new Map<string, ConfigProfile>();

  constructor(ctx: Context) {
    super(ctx, "evaluator");
  }

  registerStoreDecorator<T>(name: string, validate: PluginConfigValidator<T>, factory: StoreDecoratorFactory<T>): () => Promise<void> {
    if (!name.trim()) throw new TypeError("Store decorator name must not be empty");
    return this.ctx.effect(() => {
      if (this.storeDecorators.has(name)) throw new TypeError(`Duplicate store decorator: ${name}`);
      const entry = { validate, factory: factory as StoreDecoratorFactory<unknown> };
      this.storeDecorators.set(name, entry);
      return () => { if (this.storeDecorators.get(name) === entry) this.storeDecorators.delete(name); };
    }, `evaluator.registerStoreDecorator(${JSON.stringify(name)})`);
  }

  storeDecoratorNames(): string[] { return [...this.storeDecorators.keys()]; }

  prepareStoreDecorator(name: string, config: unknown) {
    const entry = this.storeDecorators.get(name);
    if (!entry) throw new TypeError(`Unknown store decorator: ${name}`);
    const validated = entry.validate(config);
    return (runtime: PluginFactoryContext) => entry.factory(validated, runtime);
  }

  registerProfile(value: ConfigProfile): () => Promise<void> {
    const profile = parseConfigProfile(value);
    const key = `${profile.role}:${profile.id}`;
    return this.ctx.effect(() => {
      if (this.profileRegistrations.has(key)) throw new TypeError(`duplicate profile registration: ${key}`);
      this.profileRegistrations.set(key, profile);
      return () => { if (this.profileRegistrations.get(key) === profile) this.profileRegistrations.delete(key); };
    }, `evaluator.registerProfile(${JSON.stringify(key)})`);
  }

  profiles(): ConfigProfile[] {
    return structuredClone([...this.profileRegistrations.values()]);
  }

  register<R extends PluginRole, T>(
    role: R,
    name: string,
    validate: PluginConfigValidator<T>,
    factory: PluginFactory<R, T>,
    transport?: PluginConfigTransport,
  ): () => Promise<void> {
    if (name.trim() === "") throw new TypeError("plugin registration name must not be empty");
    const key = `${role}:${name}`;

    // Service tracing replaces this.ctx with the calling plugin context. The
    // effect therefore belongs to that plugin fiber, including when apply
    // throws after this call.
    return this.ctx.effect(
      () => {
        if (this.registrations.has(key)) {
          throw new TypeError(`duplicate ${role} plugin registration: ${name}`);
        }
        const registration: Registration<R> = {
          role,
          name,
          validate: validate as PluginConfigValidator<unknown>,
          factory: factory as PluginFactory<R, unknown>,
          ...(transport === undefined ? {} : { transport }),
        };
        this.registrations.set(key, registration);
        return () => {
          if (this.registrations.get(key) === registration) {
            this.registrations.delete(key);
          }
        };
      },
      `evaluator.register(${JSON.stringify(role)}, ${JSON.stringify(name)})`,
    );
  }

  entries(): { role: PluginRole; name: string }[] {
    return [...this.registrations.values()].map(({ role, name }) => ({ role, name }));
  }

  has(role: PluginRole, name: string): boolean {
    return this.registrations.has(`${role}:${name}`);
  }

  configTransport(role: string, name: string): PluginConfigTransport | undefined {
    return this.registrations.get(`${role}:${name}`)?.transport;
  }

  prepare<R extends PluginRole>(role: R, selection: Selection): PreparedPlugin<R> {
    const registration = this.registrations.get(`${role}:${selection.name}`);
    if (!registration) {
      throw new TypeError(`unknown ${role} plugin: ${selection.name}`);
    }
    let config: unknown;
    try {
      config = registration.validate(selection.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`invalid ${role} plugin config for ${selection.name}: ${message}`, {
        cause: error,
      });
    }
    return async runtime => (await registration.factory(config, runtime)) as RoleImplementations[R];
  }

  async create<R extends PluginRole>(
    role: R,
    selection: Selection,
    runtime: FactoryContext<R>,
  ): Promise<RoleImplementations[R]> {
    return await this.prepare(role, selection)(runtime);
  }
}

export function apply(ctx: Context): void {
  new EvaluatorRegistry(ctx);
}
