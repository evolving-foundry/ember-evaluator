import { expectNonEmptyString } from "../../../core/validation/input.js";

export function localDatasetConfig(config: Record<string, unknown>): { localPath?: string } {
  return config.localPath === undefined ? {} : { localPath: expectNonEmptyString(config.localPath, "benchmark.config.localPath") };
}

export function rejectLocalDatasetTransport(config: Record<string, unknown>): void {
  if (config.localPath !== undefined) throw new TypeError("Ray cannot distribute benchmark.config.localPath; use the default remote dataset source or a local scheduler");
}
