import type { JsonValue } from "../core/contracts/task.js";
import { assertJsonValue, expectRecord } from "../core/validation/input.js";
import { type LoadedConfig } from "./loaded.js";

/** Export only current public YAML. Saved execution metadata has a separate reader. */
export function exportConfig(config: LoadedConfig): JsonValue {
  const effective = config.experiment;
  const saved = expectRecord(structuredClone(config.persisted), "saved configuration");
  const savedServices = expectRecord(saved.services, "saved services");
  const services = Object.fromEntries(Object.entries(effective.services).map(([name, model]) => {
    const reference = expectRecord(savedServices[name], `services.${name}`).apiKey;
    return [name, {
      model: model.name, base_url: model.endpoint ?? "",
      ...(model.provider === null ? {} : { provider: model.provider }),
      ...(model.api === null ? {} : { api: model.api }),
      ...(reference === undefined ? {} : { api_key: reference === "[runtime-provided]" ? "${EVALUATOR_API_KEY}" : reference }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.retry === undefined ? {} : { retry: model.retry }),
    }];
  }));
  const { solver: _solver, verifier: _verifier, network: _network, ...savedPublic } = saved;
  const output = {
    ...savedPublic, services,
    ...(config.deployment === undefined ? {} : { deployment: config.deployment }),
    benchmark: { ...effective.benchmark,
      config: expectRecord(saved.benchmark, "saved benchmark").config,
      solver: saved.solver,
      ...(effective.verifier === undefined ? {} : { verifier: saved.verifier }),
    },
    metrics: saved.metrics,
  };
  assertJsonValue(output);
  return output;
}
