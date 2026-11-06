import type { ErrorCode } from "../../core/errors/registry.js";

export class DockerEnvironmentError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
    public readonly containerId: string | null = null,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "DockerEnvironmentError";
  }
}
