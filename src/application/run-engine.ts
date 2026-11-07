import { loadRunIdentity } from "../infrastructure/provenance/run-identity.js";
import { executeEngine, type EngineExecutionInput } from "../core/execution/engine.js";
import type { LoadedConfig } from "../config/loaded.js";
import type { ResultSnapshot } from "../core/contracts/result.js";
import type { RetryController } from "../core/contracts/retry-control.js";
import { controlTransaction, RetryControl } from "./retry-control/mailbox.js";

export type EngineInput = Omit<EngineExecutionInput, "config"> & { config: LoadedConfig };

/** Own only retry controls; the caller retains ownership of its supplied components. */
export async function runEngine(input: EngineInput): Promise<ResultSnapshot> {
  const controls: { handle: RetryController; warn: (error: unknown) => void }[] = [];
  try {
    return await executeEngine(input, {
      async claim(directory, requestId, bindings) {
        await controlTransaction(directory, async state => {
          const request = state.requests.find(item => item.requestId === requestId);
          if (!request || request.status !== "pending") throw new Error("Retry request is already claimed");
          request.status = "accepted";
          request.bindings = { ...request.bindings, ...await bindings() };
        });
      },
      async start(directory, warn) {
        const handle = await RetryControl.start(directory, warn);
        controls.push({ handle, warn });
        return handle;
      },
    }, loadRunIdentity);
  } finally {
    for (const { handle, warn } of controls) {
      try { await handle.close(); } catch (error) { warn(error); }
    }
  }
}
