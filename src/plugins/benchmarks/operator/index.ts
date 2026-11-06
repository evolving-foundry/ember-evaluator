import type { Context } from "@deepseek-ai/cordis";
import { readProfileDirectory } from "../../../infrastructure/profiles/read.js";
import { KernelBenchmark, parseKernelConfig } from "./kernel/index.js";

export async function apply(ctx: Context): Promise<void> {
  for (const profile of await readProfileDirectory(new URL("./profiles/", import.meta.url))) ctx.evaluator.registerProfile(profile);
  ctx.evaluator.register("benchmark", "kernel", parseKernelConfig, (config, runtime) =>
    new KernelBenchmark({ ...config, manifest: runtime.resolvePath(config.manifest),
      profiling: { ...config.profiling, ...(config.profiling.cacheDir === undefined ? {} : { cacheDir: runtime.resolvePath(config.profiling.cacheDir) }) },
      ...(config.kernelRoot === undefined ? {} : { kernelRoot: runtime.resolvePath(config.kernelRoot) }) }, runtime.hardware));
}
