import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import type { DockerCommand } from "./runtime-contract.js";

export const CPU_VIEW_PATH = "/opt/evaluator/cpu-view.cjs";
// Old Node tools size worker pools with os.cpus(), which reports host hardware
// even after cpuset enforcement. Expose the usable count to CJS and ESM users.
export const nodeCpuViewSource = `const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");
const hardwareCpus = os.cpus;
os.cpus = () => hardwareCpus().slice(0, os.availableParallelism());
syncBuiltinESMExports();
`;

export class DockerCpuBudgetError extends Error {
  readonly code: ErrorCode = "ENV_CPU_BUDGET_FAILED";
}

export function cpuCountForBudget(cpus: number): number {
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 65_536)
    throw new DockerCpuBudgetError("Docker CPU budget must be positive, finite and at most 65536");
  return Math.ceil(cpus);
}

export function parseCpuList(value: string): number[] {
  const ids = new Set<number>();
  for (const part of value.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part);
    if (!match) throw new DockerCpuBudgetError("Invalid allowed CPU list");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(last) || last > 1_048_575 || first > last || last - first >= 65_536)
      throw new DockerCpuBudgetError("Invalid allowed CPU range");
    for (let id = first; id <= last; id++) ids.add(id);
    if (ids.size > 65_536) throw new DockerCpuBudgetError("Allowed CPU list is too large");
  }
  return [...ids].sort((left, right) => left - right);
}

export function selectCpuSet(allowed: string, cpus: number, identity: string): string {
  const ids = parseCpuList(allowed);
  const count = cpuCountForBudget(cpus);
  if (count > ids.length) throw new DockerCpuBudgetError(`Requested ${count} visible CPUs but only ${ids.length} are available`);
  const offset = createHash("sha256").update(identity).digest().readUInt32BE(0) % ids.length;
  // CPU sets are shared, not exclusive reservations. Spread concurrent tasks
  // without assuming the daemon exposes CPU IDs 0..N or pinning all to 0,1.
  return [...ids.slice(offset), ...ids.slice(0, offset)].slice(0, count).sort((left, right) => left - right).join(",");
}

export async function cpuBudgetNodeOptions(command: DockerCommand, image: string, explicit: string | undefined,
  signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let existing = explicit;
  if (existing === undefined) {
    const response = await command(["image", "inspect", image, "--format", "{{json .Config.Env}}"], { signal });
    const env: unknown = JSON.parse(response.stdout);
    if (env !== null && (!Array.isArray(env) || !env.every(item => typeof item === "string")))
      throw new DockerCpuBudgetError("Cannot read runtime image environment for CPU enforcement");
    existing = env?.findLast((item: string) => item.startsWith("NODE_OPTIONS="))?.slice("NODE_OPTIONS=".length) ?? "";
  }
  return `--require=${CPU_VIEW_PATH}${existing.trim() ? ` ${existing}` : ""}`;
}

const allowedCpuScript = "console.log(require('node:fs').readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\\s*(.+)$/m)[1])";
const checkCpuScript = "const os=require('node:os');const fs=require('node:fs');console.log(JSON.stringify({"
  + "available:os.availableParallelism(),cpus:os.cpus().length,"
  + "allowed:fs.readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\\s*(.+)$/m)[1]}))";

export async function constrainDockerCpus(command: DockerCommand, id: string, cpus: number,
  signal: AbortSignal): Promise<{ cpusetCpus: string; availableCpus: number }> {
  try {
    signal.throwIfAborted();
    const allowed = await command(["exec", id, "node", "-e", allowedCpuScript], { signal });
    const cpusetCpus = selectCpuSet(allowed.stdout, cpus, id);
    await command(["update", "--cpuset-cpus", cpusetCpus, id], { signal });
    const response = await command(["exec", id, "node", "-e", checkCpuScript], { signal });
    const visible: unknown = JSON.parse(response.stdout);
    const count = cpuCountForBudget(cpus);
    if (visible === null || typeof visible !== "object" || !("available" in visible) || visible.available !== count
      || !("cpus" in visible) || visible.cpus !== count || !("allowed" in visible) || typeof visible.allowed !== "string"
      || parseCpuList(visible.allowed).join(",") !== cpusetCpus)
      throw new DockerCpuBudgetError(`CPU visibility check failed for container ${id}; expected ${count}`);
    return { cpusetCpus, availableCpus: count };
  } catch (cause) {
    signal.throwIfAborted();
    throw new DockerCpuBudgetError(`Cannot enforce CPU budget for container ${id}`, { cause });
  }
}
