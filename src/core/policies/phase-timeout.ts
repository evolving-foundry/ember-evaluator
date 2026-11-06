import type { Phase } from "../contracts/result.js";
import type { ErrorCode } from "../errors/registry.js";

/** A phase deadline, including one enforced by a solver's own runtime. */
export class PhaseTimeoutError extends Error {
  readonly code: ErrorCode;

  constructor(readonly phase: Phase, message = `${phase} exceeded its task-specific time limit`, options?: ErrorOptions) {
    super(message, options);
    switch (phase) {
      case "solve": this.code = "SOLVER_AGENT_TIMEOUT"; break;
      case "verify": this.code = "VERIFY_TIMEOUT"; break;
      case "transfer": this.code = "TRANSFER_TIMEOUT"; break;
      case "cleanup": this.code = "CLEANUP_TIMEOUT"; break;
      case "store": this.code = "STORE_WRITE_FAILED"; break;
      case "collect": this.code = "ARTIFACT_COLLECTION_INCOMPLETE"; break;
      default: this.code = "ENV_PREPARATION_TIMEOUT";
    }
    this.name = "PhaseTimeoutError";
  }
}
