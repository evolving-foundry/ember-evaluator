import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { HardwareKind } from "../../core/contracts/hardware.js";
import type { KernelProfileArgs } from "./profile.js";
import { NpuKernelBackend } from "./npu.js";

export type KernelExecutionOptions = {
  python: string;
  device: number;
  kernelRoot?: string;
  outputLimitBytes?: number;
  cleanupGraceMs?: number;
  cleanupTimeoutMs?: number;
  profiling: Pick<KernelProfileArgs, "collection" | "warmup" | "attemptTimeoutSeconds" | "maxAttempts" | "retryDelayMs" | "cacheEnabled" | "cacheDir" | "cacheMaxEntries" | "msprofBin" | "deviceName"> & { enabled: boolean; roundNum: number };
};

/** Hardware execution only; the benchmark owns task identity and verdicts. */
export interface KernelBackend {
  environment(): Record<string, string>;
  runtimeFiles(): { path: string; origin: string }[];
  execute(request: Record<string, unknown>, session: EnvironmentSession, signal: AbortSignal): Promise<unknown>;
}

export function assertKernelHardware(hardware: HardwareKind): void {
  if (hardware === "gpu") throw new TypeError("Kernel GPU backend is not implemented; selected hardware=gpu");
}

export function createKernelBackend(hardware: HardwareKind, config: KernelExecutionOptions): KernelBackend {
  assertKernelHardware(hardware);
  return new NpuKernelBackend(config);
}
