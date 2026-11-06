import { stringify } from "yaml";
import type { ModelConfig } from "../../core/contracts/config.js";
import { AgentBundleError } from "../agentbundle/cli.js";

export const DSH_AUTH_ENV = "EMBER_EVALUATOR_API_KEY";

export function dshModelSettings(model: ModelConfig): string {
  if (model.endpoint === null && (model.provider === "amazon-bedrock" || model.provider === "azure-openai")) {
    throw new AgentBundleError(
      "CONFIG_INVALID",
      "this provider requires endpoint or authentication fields outside the supported model contract",
    );
  }
  if (
    model.endpoint === null &&
    (model.provider === "deepseek-official" || (model.provider === "deepseek" && model.api === null))
  ) {
    return stringify({
      "agent-default-model": { provider: "deepseek-official", model: model.name },
      "llm-deepseek": {
        apiKeyEnv: DSH_AUTH_ENV,
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      },
    });
  }
  if (model.endpoint !== null) {
    const url = new URL(model.endpoint);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some(key => /key|token|secret|password|auth/i.test(key))
    ) {
      throw new AgentBundleError("CONFIG_INVALID", "model endpoint cannot contain credentials");
    }
    if (!model.api) throw new AgentBundleError("CONFIG_INVALID", "an explicit endpoint requires an API protocol");
  } else if (!model.provider) throw new AgentBundleError("CONFIG_INVALID", "a provider is required without an endpoint");
  const provider = model.endpoint !== null ? "ember-evaluator" : model.provider;
  if (!provider) throw new AgentBundleError("CONFIG_INVALID", "a provider is required without an endpoint");
  return stringify({
    "agent-default-model": { provider, model: model.name },
    "llm-pi-ai": {
      providers: {
        [provider]: {
          apiKeyEnv: DSH_AUTH_ENV,
          ...(model.endpoint === null ? {} : { baseURL: model.endpoint }),
          ...(model.api === null ? {} : { api: model.api }),
          models: [{ id: model.name, ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }) }],
        },
      },
    },
  });
}

export type DshPermissionMode = "workspace-write" | "danger-full-access";

/**
 * DSH's sandbox mode with explicit noninteractive approval. The patch replaces
 * DSH's preset table, so it must keep a preset matching the composed default.
 */
export function dshPermissionPatch(mode: DshPermissionMode): string {
  return stringify([
    { id: "approval", config: { policy: "never" } },
    {
      id: "permission",
      config: {
        presets: {
          [mode]: { sandbox: mode, approval: "never" },
        },
      },
    },
  ]);
}
