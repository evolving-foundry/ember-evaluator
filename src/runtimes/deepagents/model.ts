import type { ModelConfig } from "../../core/contracts/config.js";
import { AgentBundleError } from "../agentbundle/cli.js";

/**
 * Environment binding for one solve attempt. `selection` holds non-secret
 * placement entries; the API key never appears here — only its target
 * variable name, which the solver fills from runtime auth at spawn time.
 */
export type DeepagentsModelBinding = {
  selection: Record<string, string>;
  secretEnvName: string | null;
};

/**
 * Map the evaluator model contract onto the deepagents runtime binding. The
 * bundle composition entry resolves AGENT_MODEL_* placeholders at import;
 * the langchain `openai` provider reads OPENAI_API_KEY/OPENAI_BASE_URL from
 * the process environment. Providers with their own authentication variables
 * are not validated yet and stay unsupported.
 */
export function deepagentsModelBinding(model: ModelConfig): DeepagentsModelBinding {
  if (model.maxTokens !== undefined) {
    throw new AgentBundleError(
      "CONFIG_INVALID",
      "deepagents bundles cannot bind model.maxTokens in this release; remove the field or choose the simpleagent solver",
    );
  }
  if (model.provider === "fake") {
    if (model.endpoint !== null)
      throw new AgentBundleError("CONFIG_INVALID", "the fake provider does not accept an endpoint");
    return { selection: { AGENT_MODEL_PROVIDER: "fake" }, secretEnvName: null };
  }
  if (model.endpoint === null) {
    throw new AgentBundleError(
      "CONFIG_INVALID",
      "deepagents bundles require an OpenAI-compatible endpoint in this release; provider catalog models are not validated yet",
    );
  }
  if (model.api !== "openai-completions") {
    throw new AgentBundleError(
      "CONFIG_INVALID",
      `deepagents bundles support the openai-completions API in this release, got ${JSON.stringify(model.api ?? "none")}`,
    );
  }
  const url = new URL(model.endpoint);
  if (
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some(key => /key|token|secret|password|auth/i.test(key))
  ) {
    throw new AgentBundleError("CONFIG_INVALID", "model endpoint cannot contain credentials");
  }
  return {
    selection: { AGENT_MODEL_PROVIDER: "openai", AGENT_MODEL_NAME: model.name, OPENAI_BASE_URL: model.endpoint },
    secretEnvName: "OPENAI_API_KEY",
  };
}
