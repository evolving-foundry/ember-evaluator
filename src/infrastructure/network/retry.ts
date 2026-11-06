import { setTimeout as delay } from "node:timers/promises";
import { classifyError, type ErrorContext } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { identifyNetworkFailure } from "../../core/errors/network-failure.js";

/** Use only around one repeatable network operation, never around a task or script. */
export async function retryNetworkOperation<T>(operation: () => Promise<T>, options: {
  signal: AbortSignal;
  context: ErrorContext;
  maxAttempts?: number;
  backoffMs?: number;
}): Promise<T> {
  const { signal, context, maxAttempts = 3, backoffMs = 1000 } = options;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try { const result = await operation(); signal.throwIfAborted(); return result; }
    catch (error) {
      signal.throwIfAborted();
      const failure = classifyError(error, context);
      const network = identifyNetworkFailure([failure, ...failure.causes], context);
      if (!network) throw error;
      if (attempt >= maxAttempts) {
        throw new EvaluatorError("NETWORK_FAILURE", `Network operation failed after ${attempt} attempt(s)`,
          { ...network, ...(context.operation ? { operation: context.operation } : {}) }, { cause: error });
      }
      await delay(Math.max(backoffMs * attempt, network.retryAfterMs ?? 0), undefined, { signal });
    }
  }
}

/** Consume the response within the retry boundary so an interrupted body is retried too. */
export async function fetchNetworkResponse(url: string, init: Omit<RequestInit, "body"> & { body?: string; signal: AbortSignal }, options: {
  network?: import("../../core/contracts/network.js").NetworkAccess;
  context?: ErrorContext;
  maxAttempts?: number;
  backoffMs?: number;
} = {}): Promise<Response> {
  return retryNetworkOperation(async () => {
    const response = await (options.network?.fetch ?? fetch)(url, init);
    const bytes = await response.arrayBuffer();
    if (response.status === 429 && options.context?.component === "model" &&
        /insufficient_quota|quota[ _-]exceeded|insufficient_credit|billing/iu.test(new TextDecoder().decode(bytes))) {
      throw new EvaluatorError("MODEL_QUOTA_EXHAUSTED", "Model service quota exhausted");
    }
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      const retryAfter = response.headers.get("retry-after");
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status,
        ...(retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter) ? { retryAfterMs: Math.min(86_400_000, Number(retryAfter) * 1000) } : {}) });
    }
    // Buffer metadata/model JSON responses here. File downloads continue to
    // use DatasetCache's streaming implementation.
    return new Response([101, 204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }, { signal: init.signal, context: options.context ?? { phase: "prepare", component: "source" },
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }) });
}
