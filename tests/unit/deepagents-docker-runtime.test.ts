import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEEPAGENTS_DOCKER_BUNDLE_TARGET,
  DEEPAGENTS_DOCKER_HOME_TARGET,
  DEEPAGENTS_DOCKER_UV_TARGET,
  DEEPAGENTS_VERSION,
  deepagentsDockerRuntimeInstallation,
} from "../../src/runtimes/deepagents/runtime.js";
import { runtimeInventory } from "../../src/infrastructure/runtime-installation/install.js";

const execFileAsync = promisify(execFile);
const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "deepagents");
const envSnapshot = { ...process.env };

afterEach(() => {
  process.env = { ...envSnapshot };
});

const hostUv = await execFileAsync("uv", ["--version"])
  .then(() => true)
  .catch(() => false);

describe("deepagents docker runtime installation", () => {
  it("bakes the bundle, uv binary and CLI assets with build-time venv commands", async () => {
    if (!hostUv) return;
    process.env.UV_BIN = "uv";
    const installation = await deepagentsDockerRuntimeInstallation(fixtureBundle, new AbortController().signal);
    const targets = installation.files.map(file => file.target);
    expect(targets).toContain("agentbundle/run.mjs");
    expect(targets).toContain("deepagents/runner.py");
    expect(targets).toContain("deepagents/constraints.txt");
    expect(targets).toContain(DEEPAGENTS_DOCKER_UV_TARGET);
    expect(targets).toContain(DEEPAGENTS_DOCKER_BUNDLE_TARGET);
    expect(installation.id.startsWith("deepagents-docker:")).toBe(true);
    expect(installation.commands).toHaveLength(3);
    const [venv, install, cacheClean] = installation.commands;
    if (!venv || !install || !cacheClean) throw new Error("expected three install commands");
    expect(venv).toMatchObject({
      executable: `{root}/${DEEPAGENTS_DOCKER_UV_TARGET}`,
      args: ["venv", "--python", "3.12", `{root}/${DEEPAGENTS_DOCKER_HOME_TARGET}`],
    });
    expect(venv.env).toMatchObject({ UV_PYTHON_INSTALL_DIR: "{root}/uv-python" });
    expect(install?.args).toEqual([
      "pip",
      "install",
      "--python",
      `{root}/${DEEPAGENTS_DOCKER_HOME_TARGET}/bin/python`,
      "-e",
      `{root}/${DEEPAGENTS_DOCKER_BUNDLE_TARGET}`,
    ]);
    expect(install?.env).toMatchObject({ UV_CONSTRAINT: "{root}/deepagents/constraints.txt" });
    expect(cacheClean?.args).toEqual(["cache", "clean"]);
    expect(installation.probes).toHaveLength(3);
    const pin = installation.probes[2];
    expect(pin?.executable).toBe(`{root}/${DEEPAGENTS_DOCKER_HOME_TARGET}/bin/python`);
    expect(pin?.args[1]).toContain("version(\"deepagents\")");
    expect(pin?.args[1]).toContain(JSON.stringify(DEEPAGENTS_VERSION));
  });

  it("derives a stable identity that changes with bundle content", async () => {
    if (!hostUv) return;
    process.env.UV_BIN = "uv";
    const signal = new AbortController().signal;
    const first = await deepagentsDockerRuntimeInstallation(fixtureBundle, signal);
    const second = await deepagentsDockerRuntimeInstallation(fixtureBundle, signal);
    expect(second.id).toBe(first.id);
    const staging = await mkdtemp(join(tmpdir(), "deepagents-docker-runtime-"));
    try {
      await mkdir(join(staging, "plugins", "fixture_composition"), { recursive: true });
      for (const name of ["bundle.yaml", "agent.yaml", "pyproject.toml", "langgraph.json", "dependencies.lock", "agent.py"]) {
        await copyFile(join(fixtureBundle, name), join(staging, name));
      }
      await copyFile(
        join(fixtureBundle, "plugins", "fixture_composition", "__init__.py"),
        join(staging, "plugins", "fixture_composition", "__init__.py"),
      );
      await writeFile(join(staging, "agent.py"), "# changed\n");
      const changed = await deepagentsDockerRuntimeInstallation(staging, signal);
      expect(changed.id).not.toBe(first.id);
      const inventory = await runtimeInventory(first, "linux/x64", signal);
      expect(inventory.identity).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });

  it("rejects a missing host uv with ENV_RUNTIME_INSTALL_FAILED", async () => {
    process.env.UV_BIN = join(tmpdir(), "definitely-missing-uv-binary");
    process.env.PATH = "/nonexistent-path-for-test";
    await expect(deepagentsDockerRuntimeInstallation(fixtureBundle, new AbortController().signal)).rejects.toMatchObject({
      name: "DeepagentsRuntimeError",
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
  });

  it("rejects a non-linux uv binary with ENV_RUNTIME_INSTALL_FAILED", async () => {
    const staging = await mkdtemp(join(tmpdir(), "deepagents-docker-uv-"));
    try {
      const fakeUv = join(staging, "uv");
      await writeFile(fakeUv, "#!/bin/sh\necho 'uv 9.9.9'\n");
      await chmod(fakeUv, 0o755);
      process.env.UV_BIN = fakeUv;
      await expect(deepagentsDockerRuntimeInstallation(fixtureBundle, new AbortController().signal)).rejects.toMatchObject({
        name: "DeepagentsRuntimeError",
        code: "ENV_RUNTIME_INSTALL_FAILED",
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
});
