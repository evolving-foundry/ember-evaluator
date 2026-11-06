import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import { expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { PlatformCapabilityDetector } from "../../src/infrastructure/containers/platform.js";
import { createHash } from "node:crypto";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { DOCKER_PLATFORM, PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { DockerEnvironment, parseDockerContainerEnv, parseDockerImageOverrides } from "../../src/plugins/environments/docker/environment.js";
import { redactConfig, redactSecrets } from "../../src/config/redact.js";


test("validates and copies explicit task runtime environment settings", () => {
  expect(parseDockerContainerEnv()).toEqual({});
  const input = { GOGC: "off", GOMAXPROCS: "2" };
  expect(parseDockerContainerEnv(input)).toEqual(input);
  expect(parseDockerContainerEnv(input)).not.toBe(input);
  for (const value of [null, [], { GOGC: false }, { "A=B": "x" }, { A: "x\0" }])
    expect(() => parseDockerContainerEnv(value)).toThrow("containerEnv");
});


test("validates and snapshots explicit image overrides without contacting Docker", () => {
  expect(parseDockerImageOverrides()).toEqual({});
  const input = { "registry.test/base:1": "registry.test/warm@sha256:" + "a".repeat(64) };
  const parsed = parseDockerImageOverrides(input);
  input["registry.test/base:1"] = "changed";
  expect(parsed["registry.test/base:1"]).toContain("warm@sha256:");
  for (const value of [null, [], "image", { a: 1 }, { "": "b" }, { a: "" }, { "a b": "c" }, { a: "b\0" }])
    expect(() => new DockerEnvironment({ imageOverrides: parseDockerImageOverrides(value), dockerExecutable: "must-not-run" }))
      .toThrow("imageOverrides");
});

test("evaluator runtime builds, probes and checks images for fixed amd64", async () => {
  const calls: string[][] = [];
  const images = new Map([["base", "sha256:" + "b".repeat(64)]]);
  let recipe = "";
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: '""', stderr: "" };
    calls.push(args);
    if (args[0] === "build") {
      recipe = await readFile(join(args.at(-1)!, "Dockerfile"), "utf8");
      const tag = args[args.indexOf("--tag") + 1]!;
      images.set(tag, "sha256:" + createHash("sha256").update(tag).digest("hex"));
      return { stdout: "", stderr: "" };
    }
    if (args.at(-1)?.includes("RepoDigests")) return { stdout: `${PINNED_NODE_IMAGE.split("@")[1]} []`, stderr: "" };
    const id = images.get(args[4]!);
    if (!id) throw new Error("No such image");
    return { stdout: id, stderr: "" };
  };
  await new DockerRuntime(command).prepare("base", [], new AbortController().signal);
  expect(calls.every(args => args[args.indexOf("--platform") + 1] === "linux/amd64")).toBe(true);
  expect(recipe).toContain('test "$(uname -m)" = "x86_64"');
  expect(recipe).not.toContain('= "aarch64"');
});

test("rejects an ARM64 receipt on an amd64 Docker node before image or container operations", async () => {
  const native = vi.spyOn(PlatformCapabilityDetector.prototype, "nativePlatform").mockResolvedValue("linux/amd64");
  const root = await mkdtemp(join(tmpdir(), "docker-platform-"));
  try {
    await expect(new DockerEnvironment({ dockerExecutable: "must-not-run" }).prepare({
      workdir: "/app", image: "base", initialFiles: [], runtime: [], prepared: { kind: "docker", platform: "linux/arm64" },
    }, { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
    "verify", new AbortController().signal)).rejects.toThrow("platform differs");
  } finally { native.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

const isolatedServicePolicies: NonNullable<EnvironmentSpec["network"]>[] = ["none", "model-api", { kind: "allowlist", allowedHosts: ["example.org"] }];
test.each(isolatedServicePolicies)("rejects isolated multi-container policy %j before Docker or image preparation", async network => {
  const environment = new DockerEnvironment({ dockerExecutable: "must-not-run" });
  const spec: EnvironmentSpec = { image: "base", workdir: "/app", runtime: [], initialFiles: [], network,
    services: { main: { image: "base", properties: {} }, api: { image: "base", properties: {} } } };
  const signal = new AbortController().signal;
  await expect(environment.materialize(spec, signal)).rejects.toThrow(/isolated egress policies cannot be weakened/);
  await expect(environment.prepare(spec, { root: "unused", agent: "unused", verifier: "unused", artifacts: "unused" }, "solve", signal))
    .rejects.toThrow(/isolated egress policies cannot be weakened/);
});

test.each(isolatedServicePolicies)("admits main-only Compose under isolated policy %j", async network => {
  const sentinel = new Error("synthetic platform boundary");
  const native = vi.spyOn(PlatformCapabilityDetector.prototype, "nativePlatform").mockRejectedValue(sentinel);
  const environment = new DockerEnvironment({ dockerExecutable: "must-not-run" });
  const spec: EnvironmentSpec = { image: "base", workdir: "/opt", runtime: [], initialFiles: [], network,
    services: { main: { image: null, properties: { command: ["sh", "-c", "echo fixture"] } } } };
  try {
    await expect(environment.materialize(spec, new AbortController().signal)).rejects.toBe(sentinel);
  } finally { native.mockRestore(); }
});

test.each(["/opt", "/usr/local", "/root"])("keeps %s as a cwd without treating it as a transfer root", async workdir => {
  const sentinel = new Error("synthetic platform boundary");
  const native = vi.spyOn(PlatformCapabilityDetector.prototype, "nativePlatform").mockRejectedValue(sentinel);
  try {
    await expect(new DockerEnvironment({ dockerExecutable: "must-not-run" }).prepare({ image: "base", workdir, runtime: [], initialFiles: [] },
      { root: "unused", agent: "unused", verifier: "unused", artifacts: "unused" }, "solve", new AbortController().signal)).rejects.toBe(sentinel);
  } finally { native.mockRestore(); }
});

test.each(["/", "/opt/evaluator", "/opt/evaluator-agent/state", "/proc", "/sys", "/dev", "/opt/\0"])("rejects protected cwd %j before Docker", async workdir => {
  await expect(new DockerEnvironment({ dockerExecutable: "must-not-run" }).prepare({ image: "base", workdir, runtime: [], initialFiles: [] },
    { root: "unused", agent: "unused", verifier: "unused", artifacts: "unused" }, "solve", new AbortController().signal))
    .rejects.toMatchObject({ code: "TRANSFER_UNSAFE" });
});
