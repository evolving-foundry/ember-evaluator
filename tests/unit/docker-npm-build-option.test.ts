import { expect, test } from "vitest";
import { dockerBuildNetwork } from "../../src/infrastructure/containers/build-network.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";

test("npm registry reaches package managers and participates in build identity", () => {
  const ordinary = dockerBuildNetwork(new NetworkRuntime(networkDocument({}, {})));
  expect(ordinary.identity.sources.npm.registry).toBe("https://registry.npmjs.org");
  const mirror = dockerBuildNetwork(new NetworkRuntime(networkDocument({ sources: { npm: { registry: "https://packages.example.test/npm" } } }, {})));
  for (const key of ["NPM_CONFIG_REGISTRY", "npm_config_registry", "COREPACK_NPM_REGISTRY"])
    expect(mirror.buildArgs).toContain(key + "=https://packages.example.test/npm");
  expect(mirror.identity).not.toEqual(ordinary.identity);
});
