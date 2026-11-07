import { expect, test, vi } from "vitest";
import { platformImageCommand } from "../../src/infrastructure/containers/image-inspect.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
test.each([["1.42 1.45", false], ["1.49 1.45", false], ["1.49 1.49", true], ["1.52 1.52", true]])(
  "image inspection negotiates %s before executing, platform selection=%s", async (versions, supported) => {
    const command = vi.fn<DockerCommand>(async args => ({ stdout: args[0] === "version" ? versions : "sha256:fixture", stderr: "" }));
    const inspect = platformImageCommand(command);
    const args = ["image", "inspect", "--platform", "linux/arm64", "fixture", "--format", "{{.Id}}"];
    await inspect(args); await inspect(args);
    expect(command.mock.calls.filter(([call]) => call[0] === "version")).toHaveLength(1);
    expect(command.mock.calls[1]?.[0]).toEqual(supported ? args : ["image", "inspect", "fixture", "--format", "{{.Id}}"]);
    expect(args).toContain("--platform");
  });
test("invalid capabilities and inspection errors are reported, not retried", async () => {
  const invalid = platformImageCommand(async () => ({ stdout: "unknown", stderr: "" }));
  await expect(invalid(["image", "inspect", "--platform", "linux/arm64", "fixture"])).rejects.toThrow("API capabilities");
  const command = vi.fn<DockerCommand>(async args => { if (args[0] === "version") return { stdout: "1.52 1.52", stderr: "" }; throw new Error("unavailable"); });
  await expect(platformImageCommand(command)(["image", "inspect", "--platform", "linux/arm64", "fixture"])).rejects.toThrow("unavailable");
  expect(command).toHaveBeenCalledTimes(2);
});
