import { expect, test, vi } from "vitest";
import { PlatformCapabilityDetector, parseDockerPlatform, parseDockerNativePlatform, resolveDockerPlatform } from "../../src/infrastructure/containers/platform.js";
import type { ContainerPlatform } from "../../src/core/contracts/environment.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { classifyError } from "../../src/core/errors/classify.js";

const signal = () => new AbortController().signal;

test("benchmark declarations win; YAML supplements missing requirements before Docker native", () => {
  expect(parseDockerPlatform()).toBe("auto");
  for (const value of ["auto", "linux/amd64", "linux/arm64"]) expect(parseDockerPlatform(value)).toBe(value);
  for (const value of [null, "amd64", "linux/arm/v7", "windows/amd64", false, {}])
    expect(() => parseDockerPlatform(value)).toThrow("platform");
  expect(resolveDockerPlatform("linux/arm64", "linux/amd64", "linux/amd64"))
    .toEqual({ platform: "linux/amd64", source: "benchmark", nativePlatform: "linux/amd64", execution: "native" });
  expect(resolveDockerPlatform("linux/amd64", undefined, "linux/arm64"))
    .toEqual({ platform: "linux/amd64", source: "benchmark", nativePlatform: "linux/arm64", execution: "qemu" });
  expect(resolveDockerPlatform("auto", "linux/amd64", "linux/arm64"))
    .toMatchObject({ platform: "linux/amd64", source: "benchmark", execution: "qemu" });
  expect(resolveDockerPlatform("auto", undefined, "linux/arm64"))
    .toMatchObject({ platform: "linux/arm64", source: "native", execution: "native" });
});

test.each([
  ["linux/amd64", "linux/amd64"], ["linux/x86_64", "linux/amd64"], ["linux/x64", "linux/amd64"],
  ["linux/arm64", "linux/arm64"], ["linux/aarch64\n", "linux/arm64"],
])("normalizes Docker server platform %s", (value, expected) => {
  expect(parseDockerNativePlatform(value)).toBe(expected);
});

test.each(["", "windows/amd64", "linux/arm", "linux/riscv64"])("rejects unsupported daemon platform %s", value => {
  expect(() => parseDockerNativePlatform(value)).toThrow(expect.objectContaining({ code: "ENV_ARCH_UNSUPPORTED" }));
});

test("native detection is shared and never starts an emulation container on native execution", async () => {
  const command = vi.fn<DockerCommand>(async () => ({ stdout: "linux/aarch64", stderr: "" }));
  const warning = vi.fn();
  const detector = new PlatformCapabilityDetector(command, warning);
  expect(await Promise.all([detector.nativePlatform(signal()), detector.nativePlatform(signal())]))
    .toEqual(["linux/arm64", "linux/arm64"]);
  const image = vi.fn(async () => "unused");
  await detector.ensure(resolveDockerPlatform("auto", undefined, "linux/arm64"), signal(), image);
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]?.[0]).toEqual(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
  expect(image).not.toHaveBeenCalled();
  expect(warning).not.toHaveBeenCalled();
});

function fixture(target: ContainerPlatform = "linux/amd64") {
  const command = vi.fn<DockerCommand>(async args => ({
    stdout: args[0] === "start" ? target === "linux/amd64" ? "linux/x64" : "linux/arm64" : "", stderr: "",
  }));
  const warning = vi.fn();
  const detector = new PlatformCapabilityDetector(command, warning);
  const resolution = resolveDockerPlatform(target, undefined, target === "linux/amd64" ? "linux/arm64" : "linux/amd64");
  const image = vi.fn(async () => "pinned-node-image");
  return { command, detector, resolution, image, warning };
}

test.each(["linux/amd64", "linux/arm64"] as const)("shares a successful QEMU probe for %s and cleans only its own container", async target => {
  const { command, detector, resolution, image, warning } = fixture(target);
  await Promise.all([detector.ensure(resolution, signal(), image), detector.ensure(resolution, signal(), image)]);
  await detector.ensure(resolution, signal(), image);
  expect(image).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringMatching(/QEMU.*reduce performance/u));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("may affect execution time, timeout decisions and evaluation results"));
  const calls = command.mock.calls.map(call => call[0]);
  expect(calls.map(args => args[0])).toEqual(["create", "start", "stop", "rm"]);
  const create = calls[0]!;
  expect(create).toContain(target);
  expect(create).toContain("--read-only");
  expect(create).not.toContain("--privileged");
  const name = create[create.indexOf("--name") + 1];
  expect(calls.at(-1)).toEqual(["rm", "--force", name]);
});

test("missing QEMU is an infrastructure failure and a failed probe is not cached", async () => {
  const { command, detector, resolution, image } = fixture();
  command.mockImplementation(async args => {
    if (args[0] === "start") throw new Error("exec /usr/local/bin/node: exec format error");
    return { stdout: "", stderr: "" };
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const error: unknown = await detector.ensure(resolution, signal(), image).catch(error => error);
    expect(classifyError(error, { phase: "environment" })).toMatchObject({
      code: "ENV_ARCH_UNSUPPORTED", category: "infrastructure", scope: "attempt", retryable: false, action: "finalize",
    });
    expect(error).toMatchObject({ message: expect.stringContaining("QEMU/binfmt") });
    expect(error).toMatchObject({ message: expect.stringContaining("No usable QEMU emulator is available for platform emulation") });
    expect(error).toMatchObject({ message: expect.stringContaining("target platform linux/amd64, Docker execution node linux/arm64") });
  }
  expect(command.mock.calls.filter(call => call[0][0] === "create")).toHaveLength(2);
  expect(command.mock.calls.filter(call => call[0][0] === "rm")).toHaveLength(2);
});

test("an image download failure is not relabeled as missing QEMU", async () => {
  const { command, detector, resolution } = fixture();
  const failure = new Error("registry connection refused");
  await expect(detector.ensure(resolution, signal(), async () => { throw failure; })).rejects.toBe(failure);
  expect(command).not.toHaveBeenCalled();
});

test("daemon failure remains node-scoped infrastructure failure", async () => {
  const command = vi.fn<DockerCommand>(async () => { throw new Error("daemon down"); });
  const error: unknown = await new PlatformCapabilityDetector(command).nativePlatform(signal()).catch(error => error);
  expect(classifyError(error, { phase: "environment" })).toMatchObject({
    code: "ENV_DOCKER_DAEMON_UNAVAILABLE", scope: "node", action: "stop_dispatch",
  });
});

test("cancelling one task does not abort a shared probe needed by another task", async () => {
  const { command, detector, resolution, image } = fixture();
  let release: () => void = () => {};
  const started = Promise.withResolvers<void>();
  let active: AbortSignal | undefined;
  command.mockImplementation(async (args, options) => {
    if (args[0] === "start") {
      active = options?.signal;
      started.resolve();
      await new Promise<void>(resolve => { release = resolve; });
      return { stdout: "linux/x64", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  const controller = new AbortController();
  const first = detector.ensure(resolution, controller.signal, image);
  const second = detector.ensure(resolution, signal(), image);
  await started.promise;
  controller.abort(new Error("task cancelled"));
  await expect(first).rejects.toThrow("task cancelled");
  expect(active?.aborted).toBe(false);
  release();
  await second;
  expect(command.mock.calls.filter(call => call[0][0] === "rm")).toHaveLength(1);
});

test("cancellation of the last waiter still removes a possibly allocated probe", async () => {
  const { command, detector, resolution, image } = fixture();
  const started = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  command.mockImplementation(async (args, options) => {
    if (args[0] === "start") {
      started.resolve();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener("abort",
        () => reject(options.signal?.reason), { once: true }));
    }
    if (args[0] === "rm") cleaned.resolve();
    return { stdout: "", stderr: "" };
  });
  const controller = new AbortController();
  const pending = detector.ensure(resolution, controller.signal, image);
  await started.promise;
  controller.abort(new Error("task cancelled"));
  await expect(pending).rejects.toThrow("task cancelled");
  await cleaned.promise;
  const cleanupOptions = command.mock.calls.find(call => call[0][0] === "rm")?.[1];
  expect(cleanupOptions?.signal?.aborted).toBe(false);
});
