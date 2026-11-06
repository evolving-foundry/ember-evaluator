import { expect, test, vi } from "vitest";
import { parseDockerEmulation, resolveDockerPlatform, PlatformCapabilityDetector } from "../../src/infrastructure/containers/platform.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";

test("native-only execution rejects task and YAML foreign platforms before emulation", () => {
  expect(() => resolveDockerPlatform("linux/arm64", "linux/amd64", "linux/arm64", false))
    .toThrow(/requires linux\/amd64.*allowEmulation is false/u);
  expect(() => resolveDockerPlatform("linux/amd64", undefined, "linux/arm64", false)).toThrow();
  expect(resolveDockerPlatform("auto", undefined, "linux/arm64", false)).toMatchObject({ execution: "native" });
  expect(resolveDockerPlatform("linux/arm64", undefined, "linux/arm64", false)).toMatchObject({ execution: "native" });
  expect(resolveDockerPlatform("auto", "linux/amd64", "linux/arm64")).toMatchObject({ execution: "qemu" });
});

test("emulation policy accepts only booleans and defaults to the existing behavior", () => {
  expect(parseDockerEmulation()).toBe(true);
  expect(parseDockerEmulation(false)).toBe(false);
  for (const value of ["false", 0, null, {}]) expect(() => parseDockerEmulation(value)).toThrow(/boolean/u);
});

test("environment rejects a foreign requirement before runtime installation or emulation probe", async () => {
  const native = vi.spyOn(PlatformCapabilityDetector.prototype, "nativePlatform").mockResolvedValue("linux/arm64");
  const ensure = vi.spyOn(PlatformCapabilityDetector.prototype, "ensure");
  try {
    const environment = new DockerEnvironment({ allowEmulation: false, dockerExecutable: "must-not-run" });
    await expect(environment.installRuntime({ id: "test", files: [], commands: [], probes: [] },
      new AbortController().signal, { platform: "linux/amd64", workdir: "/app", image: "base", initialFiles: [], runtime: [] }))
      .rejects.toMatchObject({ code: "ENV_ARCH_UNSUPPORTED" });
    expect(ensure).not.toHaveBeenCalled();
  } finally { native.mockRestore(); ensure.mockRestore(); }
});
