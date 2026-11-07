import { resolve } from "node:path";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";

export type NodeConfig = {
  nodeExecutable: string;
  workerEntry: string;
  configDirectory: string;
  outputRoot: string;
  caFile: string;
  tokenEnv: string;
  pluginPatchPath?: string;
  dockerExecutable?: string;
};

export function resolvePluginPatchPath(value: unknown, baseDirectory: string): string | undefined {
  if (value === undefined) return undefined;
  return resolve(baseDirectory, expectNonEmptyString(value, "Ray plugin patch path"));
}

export function parseNodeConfig(value: unknown, directory: string): NodeConfig {
  const config = expectRecord(value, "Ray node config");
  rejectUnknown(
    config,
    ["nodeExecutable", "workerEntry", "configDirectory", "outputRoot", "caFile", "tokenEnv", "pluginPatchPath", "dockerExecutable"],
    "Ray node config",
  );
  const tokenEnv = config.tokenEnv ?? "EVALUATOR_TRANSFER_TOKEN";
  if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnv))
    throw new TypeError("Invalid Ray transfer token environment variable");
  const pluginPatchPath = resolvePluginPatchPath(config.pluginPatchPath, directory);
  const path = (name: string) => resolve(directory, expectNonEmptyString(config[name], `Ray node ${name}`));
  return {
    nodeExecutable: path("nodeExecutable"),
    workerEntry: path("workerEntry"),
    configDirectory: path("configDirectory"),
    outputRoot: path("outputRoot"),
    caFile: path("caFile"),
    tokenEnv,
    ...(pluginPatchPath === undefined ? {} : { pluginPatchPath }),
    ...(config.dockerExecutable === undefined ? {} : { dockerExecutable: path("dockerExecutable") }),
  };
}
