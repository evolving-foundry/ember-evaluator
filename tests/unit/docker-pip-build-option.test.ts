import { expect, test } from "vitest";
import { dockerBuildNetwork } from "../../src/infrastructure/containers/build-network.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";

test("pip and uv use the selected indexes without inherited package manager configuration", () => {
  const access = new NetworkRuntime(networkDocument({ sources: { python: { index: "https://packages.test/simple", extraIndexes: ["https://extra.test/simple"] } } }, {}));
  const build = dockerBuildNetwork(access);
  expect(build.buildArgs).toContain("PIP_INDEX_URL=https://packages.test/simple");
  expect(build.buildArgs).toContain("UV_DEFAULT_INDEX=https://packages.test/simple");
  expect(build.buildArgs).toContain("PIP_EXTRA_INDEX_URL=https://extra.test/simple");
  expect(build.buildArgs).toContain("PIP_CONFIG_FILE=/dev/null");
});

test("pip mixed-manager override remains opt-in and changes build identity", () => {
  const network = new NetworkRuntime(networkDocument({}, {}));
  const ordinary = dockerBuildNetwork(network, {});
  const overlay = dockerBuildNetwork(network, { PIP_IGNORE_INSTALLED: "1" });
  expect(ordinary.identity).not.toHaveProperty("pipIgnoreInstalled");
  expect(ordinary.buildArgs.some(value => value.startsWith("PIP_IGNORE_INSTALLED="))).toBe(false);
  expect(overlay.buildArgs).toContain("PIP_IGNORE_INSTALLED=1");
  expect(overlay.recipe("FROM python:3.12\nRUN pip install six\n")).toContain("ARG PIP_IGNORE_INSTALLED");
  expect(overlay.identity).not.toEqual(ordinary.identity);
  expect(() => dockerBuildNetwork(network, { PIP_IGNORE_INSTALLED: "invalid" })).toThrow("PIP_IGNORE_INSTALLED");
});
