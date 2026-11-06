import { kernelBench, kernelPrecision, KernelExecError, type KernelExecOptions } from "../plugins/benchmarks/operator/kernel/runtime/cli.js";
import { kernelProfile } from "../plugins/benchmarks/operator/kernel/runtime/profile.js";

type KernelCommand =
  | { kind: "kernel-profile"; problem: string; kernel: string; out: string; round: number; seed: number; warmup: number; device: number; python?: string }
  | { kind: "kernel-precision"; problem: string; kernel: string; out: string; seeds: number[]; device: number; python?: string }
  | { kind: "kernel-bench"; problem: string; kernel: string; out: string; device: number; python?: string };

export async function executeKernelCommand(command: KernelCommand, signal: AbortSignal) {
  const options: KernelExecOptions = { signal,
    ...(command.python === undefined ? {} : { python: command.python }),
    ...(command.device === 0 ? {} : { device: command.device }) };
  try {
    const payload = command.kind === "kernel-profile" ? await kernelProfile(command, options)
      : command.kind === "kernel-precision" ? await kernelPrecision(command, options) : await kernelBench(command, options);
    return { kind: "completed" as const, payload };
  } catch (error) {
    if (error instanceof KernelExecError && !error.infra) return { kind: "evaluation-failed" as const, message: error.message };
    throw error;
  }
}
