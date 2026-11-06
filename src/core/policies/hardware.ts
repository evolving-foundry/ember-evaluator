import type { HardwareKind } from "../contracts/hardware.js";

export function gpuRequirementMessage(hardware: HardwareKind, requirement: string): string {
  return hardware === "npu"
    ? `${requirement} requires GPU; selected hardware=npu (hardware mismatch). CUDA tasks cannot run on NPU without porting`
    : `${requirement} requires GPU; selected hardware=gpu, but GPU task execution is not implemented`;
}
