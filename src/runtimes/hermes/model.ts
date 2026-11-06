import { stringify } from "yaml";
import type { ModelConfig } from "../../core/contracts/config.js";
import { AgentBundleError } from "../agentbundle/cli.js";

/** The environment variable that carries this attempt's API key for Hermes. */
export const HERMES_AUTH_ENV = "EMBER_EVALUATOR_API_KEY";

/**
 * Map the shared Evaluator {@link ModelConfig} to a Hermes `model_aliases`
 * entry. Hermes only consults `model_aliases` when the headless run is
 * launched with `-m <alias>` (see oneshot.py `_resolve_model_and_provider`),
 * and URL-bearing aliases force the bare `custom` provider with the alias's
 * own `key_env`, so this is the only path that pins a custom endpoint plus an
 * independent credential without touching `model.default`/`model.provider`
 * (which the bundle install owns).
 */
export function hermesModelSettings(model: ModelConfig): string {
  if (model.endpoint === null) {
    throw new AgentBundleError("CONFIG_INVALID", "a hermes bundle requires an explicit model endpoint (custom alias)");
  }
  const url = new URL(model.endpoint);
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /key|token|secret|password|auth/i.test(key))) {
    throw new AgentBundleError("CONFIG_INVALID", "model endpoint cannot contain credentials");
  }
  return stringify({
    model_aliases: {
      [model.name]: {
        model: model.name,
        provider: "custom",
        base_url: model.endpoint,
        key_env: HERMES_AUTH_ENV,
      },
    },
  });
}
