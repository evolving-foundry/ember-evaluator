import type { ErrorCode } from "../errors/registry.js";
export class ResumeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResumeError";
  }
}
