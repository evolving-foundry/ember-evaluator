import type { PluginConfigTransport } from "../../../../../core/contracts/config-transport.js";
import { parseHarborConfig } from "./config.js";

export const harborConfigTransport: PluginConfigTransport = {
  nodeLocal: { cacheDir: "cache" },
  containerPaths: [["defaults", "workdir"], ["taskProfiles", "*", "workdir"], ["taskProfiles", "*", "extraPaths", "*"]],
  validate(config) {
    if (parseHarborConfig(config).source?.kind === "local")
      throw new TypeError("Ray cannot distribute a local Harbor source; use a pinned archive or Git source");
  },
};
