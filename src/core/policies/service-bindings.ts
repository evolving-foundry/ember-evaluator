import type { ExecutionConfig, ModelConfig, RuntimeAuth } from "../contracts/config.js";
import { expectNonEmptyString } from "../validation/input.js";

/** Pure references check, shared by configuration loading and standalone assembly. */
export function assertServiceBindings(config: ExecutionConfig): void {
  const experiment = config.experiment;
  const routes = [
    ["solver.service", experiment.solver.service],
    ["verifier.service", experiment.verifier?.service],
    ["benchmark.config.judgeService", experiment.benchmark.config.judgeService],
  ] as const;
  for (const [field, value] of routes) {
    if (value === undefined) continue;
    const name = expectNonEmptyString(value, field);
    if (!Object.hasOwn(experiment.services, name)) throw new TypeError(`${field} references unknown service ${name}`);
    if (!Object.hasOwn(config.auths, name)) throw new TypeError(`${field} service ${name} has no credentials`);
  }
}

/** Model and credential the solver selection names. */
export function solverBinding(config: ExecutionConfig): { service: string; model: ModelConfig; auth: RuntimeAuth } {
  const service = config.experiment.solver.service;
  const model = config.experiment.services[service];
  const auth = config.auths[service];
  if (!model || !auth) throw new TypeError(`solver references unknown service ${service}`);
  return { service, model, auth };
}
