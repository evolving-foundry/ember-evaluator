import type { HardwareKind } from "../../core/contracts/hardware.js";
import type { PhaseTimeoutOverrides } from "../../core/contracts/task.js";
import { Service, type Context } from "@deepseek-ai/cordis";

import type { ModelConfig, RuntimeAuth, Selection } from "../../core/contracts/config.js";
import type { Benchmark } from "../../core/contracts/benchmark.js";
import type { Environment } from "../../core/contracts/environment.js";
import type { Metrics } from "../../core/contracts/metrics.js";
import type { Reporter } from "../../core/contracts/reporter.js";
import type { RunStore } from "../../core/contracts/run-store.js";
import type { TaskScheduler } from "../../core/contracts/scheduler.js";
import type { Solver } from "../../core/contracts/solver.js";
import type { Verifier } from "../../core/contracts/verifier.js";
import { parseConfigProfile, type ConfigProfile } from "../../config/profile-schema.js";
import type { PluginConfigTransport } from "../../core/contracts/config-transport.js";

import type { PluginRole, RoleImplementations, PluginConfigValidator, PluginFactory, FactoryContext, PreparedPlugin } from "../../core/contracts/plugin.js";

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
  private readonly profileRegistrations = new Map<string, ConfigProfile>();

  constructor(ctx: Context) {
    super(ctx, "evaluator");
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
