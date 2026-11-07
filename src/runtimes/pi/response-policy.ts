import type { ErrorCode } from "../../core/errors/registry.js";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { serviceOutputBudget } from "./model.js";

export type ResponsePolicy = {
  knownContext: boolean;
  setCompactionEnabled(enabled: boolean): void;
  warning(code: ErrorCode, message: string): void;
};

/** Adapt only lifecycle policy; the SDK retains context summarization and tools. */
export function responsePolicyExtension(policy: ResponsePolicy): InlineExtension {
  return { name: "evaluator-model-responses", factory: pi => {
    let truncated = false;
    let compacting = false;
    pi.on("message_end", event => {
      const message = event.message;
      if (message.role !== "assistant" || message.stopReason !== "length") return;
      truncated = true;
      // Suppress the SDK's length recovery before it can omit the response or
      // compact. Preserve the original message/finish reason and normal queue.
      policy.setCompactionEnabled(false);
      policy.warning("SOLVER_OUTPUT_LIMIT",
        `Model response was truncated (finish_reason=length; outputTokens=${message.usage.output}; reasoningTokens=${message.usage.reasoning ?? "unknown"}); continuing normal evaluation without retry.`);
    });
    pi.on("before_provider_request", (event, context) => {
      // A naturally scheduled next turn may use normal context handling again.
      if (truncated) { truncated = false; policy.setCompactionEnabled(true); }
      // Summary generation retains the Harness's own summary budget.
      return compacting ? event.payload : serviceOutputBudget(event.payload, context.model?.api ?? "");
    });
    pi.on("session_before_compact", event => {
      if (truncated || (event.reason === "threshold" && !policy.knownContext)) return { cancel: true };
      compacting = true;
    });
    pi.on("session_compact", () => { compacting = false; });
    pi.on("session_compact_failed", () => { compacting = false; });
  } };
}
