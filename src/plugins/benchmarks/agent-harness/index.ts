import type { Context } from "@deepseek-ai/cordis";
import { DefinedBenchmark } from "./definitions/defined-benchmark.js";
import { DEFINED_BENCHMARKS } from "./definitions/index.js";
import { HarborBenchmark, parseHarborConfig } from "./protocols/harbor/index.js";
import { LocalRecordSource } from "../../../infrastructure/datasets/sources/local/files-source.js";
import { LocalZipJsonSource } from "../../../infrastructure/datasets/sources/local/zip-json-source.js";
import { localDatasetConfig, rejectLocalDatasetTransport } from "../shared/local-data.js";
import { HuggingFaceFilesSource } from "../../../infrastructure/datasets/sources/huggingface/files-source.js";
import { HttpZipJsonSource } from "../../../infrastructure/datasets/sources/http/zip-json-source.js";
import { dropDefinition } from "./definitions/drop.js";
import { expectRecord, rejectUnknown, expectNonEmptyString } from "../../../core/validation/input.js";
import { type PluginFactoryContext } from "../../../core/contracts/plugin.js";
import { readProfileDirectory } from "../../../infrastructure/profiles/read.js";
import { harborConfigTransport } from "./protocols/harbor/config-transport.js";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "./definitions/officeqa-pro-v2/index.js";

export async function apply(ctx: Context): Promise<void> {
  for (const profile of await readProfileDirectory(new URL("./profiles/", import.meta.url))) ctx.evaluator.registerProfile(profile);
  ctx.evaluator.register("benchmark", "officeqa-pro-v2", parseOfficeQAProV2Config, (config, runtime) =>
    new OfficeQAProV2Benchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir),
      ...(config.localPath === undefined ? {} : { localPath: runtime.resolvePath(config.localPath) }) }, undefined, undefined, runtime.network),
    { nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" }, secretFields: ["hfToken"], validate: rejectLocalDatasetTransport });
  ctx.evaluator.register("benchmark", "drop", value => {
    const config = expectRecord(value, "drop");
    rejectUnknown(config, ["cacheDir", "localPath"], "drop");
    return { cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/drop", "drop.cacheDir"), ...localDatasetConfig(config) };
  }, (config, runtime) => new DefinedBenchmark(dropDefinition, config.localPath === undefined ? new HttpZipJsonSource(runtime.resolvePath(config.cacheDir), {
    url: "https://s3-us-west-2.amazonaws.com/allennlp/datasets/drop/drop_dataset.zip",
    sha256: "39d2278a29fd729de301b111a45f434c24834f40df8f4ff116d864589e3249d6",
    selections: { train: "drop_dataset/drop_dataset_train.json", test: "drop_dataset/drop_dataset_dev.json" },
  }, runtime.network) : new LocalZipJsonSource(runtime.resolvePath(config.localPath), {
    train: "drop_dataset/drop_dataset_train.json", test: "drop_dataset/drop_dataset_dev.json",
  }), { network: runtime.network, dockerExecutable: "docker" }), { nodeLocal: { cacheDir: "cache" }, validate: rejectLocalDatasetTransport });
  ctx.evaluator.register(
    "benchmark",
    "harbor",
    parseHarborConfig,
    (config, runtime) => new HarborBenchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir),
      ...(config.source?.kind === "local" ? { source: { ...config.source, path: runtime.resolvePath(config.source.path) } } : {}) }, undefined, runtime.verifier, runtime.phaseTimeouts, runtime.hardware, runtime.network),
    harborConfigTransport,
  );
  for (const { definition, source } of DEFINED_BENCHMARKS) {
    const name = definition.name;
    const requiresJudge = ["healthbench", "simpleqa", "math500"].includes(name);
    ctx.evaluator.register(
      "benchmark",
      name,
      (value: unknown) => {
        const config = expectRecord(value, name);
        rejectUnknown(config, ["cacheDir", "hfToken", "dockerExecutable", "localPath", ...(requiresJudge ? ["judgeService"] : [])], name);
        const cacheDir = expectNonEmptyString(config.cacheDir ?? ".cache/huggingface", `${name}.cacheDir`);
        const dockerExecutable = expectNonEmptyString(config.dockerExecutable ?? "docker", `${name}.dockerExecutable`);
        return { cacheDir, dockerExecutable, ...localDatasetConfig(config),
          ...(config.hfToken === undefined ? {} : { hfToken: expectNonEmptyString(config.hfToken, `${name}.hfToken`) }),
          ...(requiresJudge ? { judgeService: expectNonEmptyString(config.judgeService, `${name}.judgeService`) } : {}) };
      },
      (config, runtime) =>
        new DefinedBenchmark(
          definition,
          config.localPath === undefined
            ? new HuggingFaceFilesSource(runtime.resolvePath(config.cacheDir), name, source, config.hfToken ?? process.env.HF_TOKEN, undefined, runtime.network)
            : new LocalRecordSource(runtime.resolvePath(config.localPath), source),
          { network: runtime.network, dockerExecutable: config.dockerExecutable,
            ...(config.judgeService === undefined ? {} : { judgeService: config.judgeService, judge: requireJudgeService(runtime, config.judgeService) }) },
        ),
      { nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" }, secretFields: ["hfToken"], validate: rejectLocalDatasetTransport },
    );
  }
}

function requireJudgeService(runtime: PluginFactoryContext, name: string) {
  const binding = runtime.services[name];
  if (!binding) throw new TypeError(`Judge service ${name} is unavailable; declare it in services and provide its credentials`);
  return binding;
}
