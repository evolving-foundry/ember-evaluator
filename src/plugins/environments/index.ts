import type { Context } from "@deepseek-ai/cordis";
import { LocalEnvironment } from "./local/environment.js";
import { DockerEnvironment, parseDockerContainerEnv, parseDockerImageOverrides } from "./docker/environment.js";
import { parseBuildPipConstraints } from "../../infrastructure/containers/pip-constraints.js";
import { parseDockerPlatform, parseDockerEmulation } from "../../infrastructure/containers/platform.js";
import { PINNED_NODE_IMAGE } from "../../infrastructure/containers/runtime-contract.js";
import { expectRecord, rejectUnknown, expectNonEmptyString } from "../../core/validation/input.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register(
    "environment",
    "local",
    (config: unknown) => {
      if (config === null || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 0) {
        throw new TypeError("local environment config must be empty");
      }
      return {};
    },
    (_config, runtime) => new LocalEnvironment(undefined, undefined, runtime.network),
  );
  ctx.evaluator.register(
    "environment",
    "docker",
    (value: unknown) => {
      const config = expectRecord(value, "docker environment");
      rejectUnknown(config, ["dockerExecutable", "nodeImage", "image", "platform", "allowEmulation", "containerEnv", "buildPipConstraints", "imageOverrides"], "docker environment");
      const nodeImage =
        config.nodeImage === undefined ? undefined : expectNonEmptyString(config.nodeImage, "nodeImage");
      if (nodeImage !== undefined && nodeImage !== PINNED_NODE_IMAGE)
        throw new TypeError(`docker nodeImage must equal the pinned runtime image ${PINNED_NODE_IMAGE}`);
      return {
        platform: parseDockerPlatform(config.platform),
        ...(config.allowEmulation === undefined ? {} : { allowEmulation: parseDockerEmulation(config.allowEmulation) }),
        ...(config.containerEnv === undefined ? {} : { containerEnv: parseDockerContainerEnv(config.containerEnv) }),
        ...(config.buildPipConstraints === undefined ? {} : { buildPipConstraints: parseBuildPipConstraints(config.buildPipConstraints) }),
        ...(config.imageOverrides === undefined ? {} : { imageOverrides: parseDockerImageOverrides(config.imageOverrides) }),
        ...(config.dockerExecutable === undefined
          ? {}
          : { dockerExecutable: expectNonEmptyString(config.dockerExecutable, "dockerExecutable") }),
        ...(nodeImage === undefined ? {} : { nodeImage }),
        // Base task image for benchmarks that do not ship container images
        // (e.g. HF datasets); solver runtimes are layered on top of it.
        ...(config.image === undefined ? {} : { image: expectNonEmptyString(config.image, "image") }),
      };
    },
    (config, runtime) => new DockerEnvironment({ ...config, network: runtime.network, benchmarkName: runtime.benchmarkName, ...(runtime.imageConfigFingerprint ? { imageConfigFingerprint: runtime.imageConfigFingerprint } : {}), modelEndpoint: runtime.services[runtime.solverService]?.model.endpoint ?? null,
      ...(runtime.onWarning === undefined ? {} : { onWarning: runtime.onWarning }) }),
    { nodeLocal: { dockerExecutable: "docker" } },
  );
}
