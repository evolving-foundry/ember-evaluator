import type { EnvironmentSpec } from "../../core/contracts/environment.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import type { DockerCommand } from "./runtime-contract.js";

export type DockerCapacity = { cpus: number; memoryBytes: number };

export async function readDockerCapacity(command: DockerCommand, signal: AbortSignal): Promise<DockerCapacity> {
  const result = await command(["info", "--format", "{{json .}}"], { signal });
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== "object" || !("NCPU" in value) || !("MemTotal" in value) ||
      typeof value.NCPU !== "number" || !Number.isFinite(value.NCPU) || value.NCPU <= 0 ||
      typeof value.MemTotal !== "number" || !Number.isFinite(value.MemTotal) || value.MemTotal <= 0)
    throw new TypeError("Docker info is missing CPU/memory capacity");
  return { cpus: value.NCPU, memoryBytes: value.MemTotal };
}

export function assertDockerCapacity(resources: EnvironmentSpec["resources"], capacity: DockerCapacity): void {
  let memoryBytes = 0;
  if (resources?.memory !== undefined) {
    const match = /^(\d+(?:\.\d+)?)([bkmg])?(?:i?b)?$/iu.exec(resources.memory);
    if (!match) throw new TypeError("Invalid Docker memory requirement");
    memoryBytes = Number(match[1]) * 1024 ** ({ b: 0, k: 1, m: 2, g: 3 }[match[2]?.toLowerCase() ?? "b"] ?? 0);
  }
  if ((resources?.cpus ?? 0) > capacity.cpus || memoryBytes > capacity.memoryBytes)
    throw new EvaluatorError("ENV_RESOURCE_REQUIREMENTS_UNMET",
      `Task requires ${resources?.cpus ?? "unspecified"} CPUs and ${resources?.memory ?? "unspecified"} memory; ` +
      `Docker host provides ${capacity.cpus} CPUs and ${capacity.memoryBytes} bytes`,
      { component: "docker", operation: "resource-admission" });
}
