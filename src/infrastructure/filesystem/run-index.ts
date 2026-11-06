import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomic } from "./atomic-json.js";

const indexRoot = () => process.env.EVALUATOR_RUN_INDEX_DIR ?? join(homedir(), ".ember", "runs");
export const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) || value.endsWith(".")) throw new TypeError("Unsafe run/request ID");
  return value;
};
export async function registerRunLocation(runId: string, directory: string, indexDirectory = indexRoot()): Promise<void> {
  await mkdir(indexDirectory, { recursive: true });
  await atomic(join(indexDirectory, `${safeId(runId)}.json`), { runId, directory: resolve(directory) });
}
export async function locateRun(value: string): Promise<string> {
  if (value.includes("/") || value.includes("\\")) return resolve(value);
  const item: unknown = JSON.parse(await readFile(join(indexRoot(), `${safeId(value)}.json`), "utf8"));
  if (!item || typeof item !== "object" || !("runId" in item) || item.runId !== value || !("directory" in item) || typeof item.directory !== "string") throw new Error("Invalid run index");
  return item.directory;
}
export async function registerGatewayRun(runId: string, configPath: string, jobId: string, configDirectory: string, patchPath?: string): Promise<void> {
  await mkdir(indexRoot(), { recursive: true });
  await atomic(join(indexRoot(), `${safeId(runId)}.json`), { runId, gatewayConfig: resolve(configPath), jobId, configDirectory, ...(patchPath ? { patchPath } : {}) });
}
export async function gatewayRun(value: string): Promise<{ gatewayConfig: string; jobId: string; configDirectory: string; patchPath?: string } | null> {
  if (value.includes("/") || value.includes("\\")) return null;
  try {
    const item: unknown = JSON.parse(await readFile(join(indexRoot(), `${safeId(value)}.json`), "utf8"));
    if (item && typeof item === "object" && "gatewayConfig" in item && typeof item.gatewayConfig === "string" && "jobId" in item && typeof item.jobId === "string") return { gatewayConfig: item.gatewayConfig, jobId: item.jobId, configDirectory: "configDirectory" in item && typeof item.configDirectory === "string" ? item.configDirectory : resolve(item.gatewayConfig, ".."), ...("patchPath" in item && typeof item.patchPath === "string" ? { patchPath: item.patchPath } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return null;
}
