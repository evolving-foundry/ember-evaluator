import type { Context } from "@deepseek-ai/cordis";
import { AgentXBenchmark, parseAgentXConfig } from "./agentx/agentx-benchmark.js";
import { rejectLocalDatasetTransport } from "../shared/local-data.js";
import { readProfileDirectory } from "../../../infrastructure/profiles/read.js";

export async function apply(ctx: Context): Promise<void> {
  for (const profile of await readProfileDirectory(new URL("./profiles/", import.meta.url))) ctx.evaluator.registerProfile(profile);
  ctx.evaluator.register("benchmark", "agentx", parseAgentXConfig, (config, runtime) =>
    new AgentXBenchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir),
      ...(config.localPath === undefined ? {} : { localPath: runtime.resolvePath(config.localPath) }) }, runtime.environmentName ?? "local", undefined, runtime.network),
    { nodeLocal: { cacheDir: "cache" }, secretFields: ["hfToken"], validate: rejectLocalDatasetTransport });
}
