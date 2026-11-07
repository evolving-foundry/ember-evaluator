import type { ContainerPlatform, PreparationCacheSource } from "../../core/contracts/environment.js";

export const PINNED_NODE_IMAGE =
  "node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c";
export const DOCKER_PLATFORM = "linux/amd64";
export const EVALUATOR_NODE_EXECUTABLE = "/usr/local/bin/node";
export const PROCESS_HELPER = "/opt/evaluator/docker-process.mjs";

export type DockerCommand = (
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; input?: Uint8Array | null; signal?: AbortSignal; maxBuffer?: number;
    onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void },
) => Promise<{ stdout: string; stderr: string }>;

export type PreparedRuntimeImage = {
  image: string;
  digest: string;
  baseDigest: string;
  runtimes: { name: string; version: string; executable: string }[];
};
