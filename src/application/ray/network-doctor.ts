import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkAccess } from "../../core/contracts/network.js";
import type { NetworkProbe } from "../diagnostics/network.js";
import { networkCommand } from "../../infrastructure/network/command.js";
import { networkSnapshot } from "../../config/network-schema.js";
import { parseRayConfig } from "../../config/ray.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";

export async function diagnoseRayNetwork(config: unknown, network: NetworkAccess, benchmark: string,
  experimentPath: string, signal: AbortSignal): Promise<NetworkProbe[]> {
  const settings = parseRayConfig(config);
  const directory = await mkdtemp(join(tmpdir(), "evaluator-ray-network-"));
  try {
    const payload = join(directory, "request.json");
    await writeFile(payload, JSON.stringify({ network: networkSnapshot(network, benchmark), packageDigest: await loadPackageDigest(),
      endpoint: settings.endpoint, nodes: settings.nodes }), { mode: 0o600 });
    const executable = /[/\\]/u.test(settings.pythonExecutable) ? resolve(dirname(experimentPath), settings.pythonExecutable) : settings.pythonExecutable;
    const result = await networkCommand(executable, [fileURLToPath(new URL("../../infrastructure/ray/python/network_doctor.py", import.meta.url)), payload],
      { signal, env: network.environment("host", process.env) });
    if (result.exitCode !== 0) throw new Error("Ray network diagnosis failed; check Python/Ray versions, endpoint and node deployment");
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" ||
      !["passed", "failed", "not-checked", "not-applicable"].includes(row.status) ||
      ["name", "location", "target", "route", "evidence"].some(key => typeof row[key] !== "string") || !Number.isFinite(row.elapsedMs)))
      throw new Error("Invalid Ray network probe response");
    return value as NetworkProbe[];
  } finally { await rm(directory, { recursive: true, force: true }); }
}
