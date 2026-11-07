import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { canonicalJson } from "../../core/results/run-manifest.js";

/** Bumped whenever the runner contract changes; part of the installation id. */
export const DIFY_RUNNER_VERSION = "2";
export const difyRunner = fileURLToPath(new URL("./assets/runner.mjs", import.meta.url));

/**
 * The dify runner only needs Node (built-ins only, including fetch); it is
 * materialized into local runtime homes and baked into docker derived images
 * via the generic installation description.
 */
export async function difyRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const runner = await readFile(difyRunner, { signal });
  const files = [{ source: difyRunner, target: "dify/runner.mjs" }];
  const commands: RuntimeInstallation["commands"] = [];
  const probes = [{ executable: "node", args: ["--version"] }];
  const hash = createHash("sha256").update(`dify-runtime-${DIFY_RUNNER_VERSION}`).update(runner);
  for (const file of files) {
    hash.update(file.target);
    hash.update(runner);
  }
  hash.update(canonicalJson({ commands, probes }));
  return { id: `dify:${hash.digest("hex")}`, cacheName: `dify-v${DIFY_RUNNER_VERSION}`, files, commands, probes };
}
