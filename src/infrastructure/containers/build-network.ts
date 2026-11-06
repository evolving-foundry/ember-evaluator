import type { NetworkAccess } from "../../core/contracts/network.js";
import { NetworkRuntime } from "../network/runtime.js";
import { aptSourceInstructions } from "./apt-sources.js";
import { insertDockerfileStageSettings } from "./dockerfile.js";

/** Explicit build settings; daemon/FROM connectivity is configured separately. */
export function dockerBuildNetwork(access: NetworkAccess = new NetworkRuntime(), installerEnvironment: NodeJS.ProcessEnv = process.env) {
  const environment = access.environment("build");
  const pipIgnoreInstalled = installerEnvironment.PIP_IGNORE_INSTALLED;
  if (pipIgnoreInstalled !== undefined) {
    if (!["0", "1", "false", "true"].includes(pipIgnoreInstalled)) throw new TypeError("PIP_IGNORE_INSTALLED must be 0, 1, false or true");
    environment.PIP_IGNORE_INSTALLED = pipIgnoreInstalled;
  }
  const mode = access.settings.docker.buildNetwork;
  const instructions = Object.keys(environment).filter(key => !/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key)).map(key => `ARG ${key}`);
  instructions.push(...aptSourceInstructions(access.settings.sources.apt));
  return {
    identity: { sources: access.settings.sources, network: mode, proxy: access.settings.proxy.build,
      ...(pipIgnoreInstalled === undefined ? {} : { pipIgnoreInstalled }) },
    environment: { ...process.env, ...environment, BUILDX_BUILDER: "", DOCKER_BUILDKIT: "1" },
    buildArgs: [
      ...(mode === "host" ? ["--network", "host"] : []),
      "--add-host", "host.docker.internal:host-gateway",
      ...Object.entries(environment).flatMap(([key, value]) => ["--build-arg", /^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) ? key : `${key}=${value}`]),
    ],
    recipe(source: string): string {
      let recipe = insertDockerfileStageSettings(source, instructions, undefined, true);
      if (recipe === source) throw new TypeError("Dockerfile has no FROM instruction");
      for (const [origin, replacement] of [
        ["https://nodejs.org/dist/", access.settings.sources.node.dist + "/"],
        ["https://raw.githubusercontent.com/", access.settings.sources.github.raw + "/"],
        ["https://api.github.com/", access.settings.sources.github.api + "/"],
        ["https://github.com/", access.settings.sources.github.repository + "/"],
      ] as const) recipe = recipe.replaceAll(origin, replacement);
      return recipe;
    },
  };
}
