import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ProviderStreams } from "@earendil-works/pi-ai";

/** SDK model metadata requires a token budget; an unset user ceiling stays unset on the wire. */
export const streamWithProviderOutput: ProviderStreams["streamSimple"] = (model, context, options) =>
  openAICompletionsApi().streamSimple(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const next = await options?.onPayload?.(payload, payloadModel) ?? payload;
      if (next === null || typeof next !== "object" || Array.isArray(next))
        throw new TypeError("OpenAI request payload must be an object");
      const request: Record<string, unknown> = { ...next };
      delete request.max_tokens;
      delete request.max_completion_tokens;
      return request;
    },
  });
