import { execFile } from "node:child_process";
import { cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as uvBinary from "../../src/infrastructure/runtime-installation/uv-binary.js";
import {
  JIUWENSWARM_DOCKER_BUNDLE_TARGET,
  JIUWENSWARM_DOCKER_HOME_TARGET,
  JIUWENSWARM_DOCKER_SOURCE_TARGET,
  JIUWENSWARM_DOCKER_UV_TARGET,
  jiuwenswarmDockerRuntimeInstallation,
  jiuwenswarmRewriteRequirements,
} from "../../src/runtimes/jiuwenswarm/runtime.js";
import { runtimeInventory } from "../../src/infrastructure/runtime-installation/install.js";

const execFileAsync = promisify(execFile);
const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "jiuwenswarm");
const envSnapshot = { ...process.env };
const temporary: string[] = [];
const sdkWheelName = "openjiuwen-0.1.18-py3-none-any.whl";
const routerWheelName = "intelli_router-0.1.0-py3-none-any.whl";
const sdkWheelPath = join(tmpdir(), sdkWheelName);
const routerWheelPath = join(tmpdir(), routerWheelName);
const sdkRequirement = `openjiuwen @ ${pathToFileURL(sdkWheelPath).href}`;

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...envSnapshot };
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixtureUv(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jiuwenswarm-recipe-uv-"));
  temporary.push(root);
  const path = join(root, "uv");
  await writeFile(path, "fixture uv binary\n");
  vi.spyOn(uvBinary, "resolveLinuxUvBinary").mockResolvedValue({ path, version: "uv 0.9.9" });
}

const GIT_OPENJIUWEN =
  "openjiuwen @ git+https://gitcode.com/openJiuwen/agent-core.git@9e3390195a9ea15235b2b5f7412cb2aa440622cc";

/** Synthetic checkout: CI has no companion workswarm clone, so the tests build one. */
async function fakeCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jiuwenswarm-checkout-"));
  temporary.push(root);
  process.env.JIUWENSWARM_OPENJIUWEN_WHEEL = join(root, sdkWheelName);
  process.env.JIUWENSWARM_INTELLI_ROUTER_WHEEL = join(root, routerWheelName);
  await writeFile(process.env.JIUWENSWARM_OPENJIUWEN_WHEEL, "fixture pinned SDK wheel");
  await writeFile(process.env.JIUWENSWARM_INTELLI_ROUTER_WHEEL, "fixture pinned router wheel");
  for (const entry of ["jiuwenswarm", "jiuwenbox"]) await mkdir(join(root, entry), { recursive: true });
  await writeFile(join(root, "jiuwenswarm", "__init__.py"), "");
  await writeFile(join(root, "jiuwenbox", "__init__.py"), "");
  await writeFile(join(root, "MANIFEST.in"), "recursive-include jiuwenswarm/resources *\n");
  await writeFile(join(root, "LICENSE"), "Apache-2.0\n");
  await writeFile(join(root, "OPEN_SOURCE_SOFTWARE_NOTICE.md"), "notice\n");
  await writeFile(
    join(root, "pyproject.toml"),
    [
      "[project]",
      'name = "workswarm"',
      'version = "0.2.5.beta1"',
      "dependencies = [",
      '    "openjiuwen @ git+https://gitcode.com/openJiuwen/agent-core.git@9e3390195a9ea15235b2b5f7412cb2aa440622cc",',
      '    "loguru>=0.7.3,<0.8",',
      "]",
      "",
      "[tool.uv.sources]",
      "workswarm-tui = { path = './packages/jiuwenswarm-tui' }",
      'openjiuwen = { git = "https://gitcode.com/openJiuwen/agent-core.git", rev = "9e3390195a9ea15235b2b5f7412cb2aa440622cc" }',
      "",
    ].join("\n"),
  );
  return root;
}

describe("jiuwenswarm docker runtime installation", () => {
  it("bakes the pinned checkout, uv binary and bundle with build-time venv commands", async () => {
    await fixtureUv();
    process.env.UV_BIN = "uv";
    process.env.JIUWENSWARM_CHECKOUT = await fakeCheckout();
    const installation = await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, new AbortController().signal);
    const targets = installation.files.map(file => file.target);
    expect(targets).toContain("agentbundle/run.mjs");
    expect(targets).toContain("jiuwenswarm/rewrite-requirements.mjs");
    expect(targets).toContain("jiuwenswarm/probe-rwlock.py");
    expect(targets).toContain(`${JIUWENSWARM_DOCKER_SOURCE_TARGET}/pyproject.toml`);
    expect(targets).toContain(`${JIUWENSWARM_DOCKER_SOURCE_TARGET}/jiuwenswarm`);
    expect(targets).toContain(`${JIUWENSWARM_DOCKER_SOURCE_TARGET}/jiuwenbox`);
    expect(targets).toContain(JIUWENSWARM_DOCKER_UV_TARGET);
    expect(targets).toContain(JIUWENSWARM_DOCKER_BUNDLE_TARGET);
    expect(targets).toContain(`jiuwenswarm/deps/${sdkWheelName}`);
    expect(targets).toContain(`jiuwenswarm/deps/${routerWheelName}`);
    // tests, docs and the checkout's own venv never reach the image
    expect(targets.some(target => target.includes("tests/") || target.includes("docs/") || target.includes(".venv"))).toBe(false);
    expect(installation.id.startsWith("jiuwenswarm-docker:")).toBe(true);

    const [rewrite, venv, install, cacheClean] = installation.commands;
    if (!rewrite || !venv || !install || !cacheClean) throw new Error("expected four install commands");
    expect(rewrite).toMatchObject({
      executable: "node",
      args: [
        "{root}/jiuwenswarm/rewrite-requirements.mjs",
        `{root}/${JIUWENSWARM_DOCKER_SOURCE_TARGET}/pyproject.toml`,
        `{root}/jiuwenswarm/deps/${sdkWheelName}`,
        `{root}/jiuwenswarm/deps/${routerWheelName}`,
      ],
    });
    expect(venv).toMatchObject({
      executable: `{root}/${JIUWENSWARM_DOCKER_UV_TARGET}`,
      args: ["venv", "--python", "3.12", `{root}/${JIUWENSWARM_DOCKER_HOME_TARGET}`],
    });
    expect(venv.env).toMatchObject({ UV_PYTHON_INSTALL_DIR: "{root}/uv-python", UV_HTTP_TIMEOUT: "300" });
    expect(install).toMatchObject({
      executable: `{root}/${JIUWENSWARM_DOCKER_UV_TARGET}`,
      args: [
        "pip",
        "install",
        "--override",
        `{root}/${JIUWENSWARM_DOCKER_SOURCE_TARGET}/evaluator-overrides.txt`,
        "--python",
        `{root}/${JIUWENSWARM_DOCKER_HOME_TARGET}/bin/python`,
        `{root}/${JIUWENSWARM_DOCKER_SOURCE_TARGET}`,
      ],
    });
    expect(cacheClean?.args).toEqual(["cache", "clean"]);

    expect(installation.probes).toHaveLength(4);
    expect(installation.probes[3]).toEqual({
      executable: `{root}/${JIUWENSWARM_DOCKER_HOME_TARGET}/bin/python`,
      args: ["{root}/jiuwenswarm/probe-rwlock.py"],
    });
    expect(installation.probes[2]).toMatchObject({
      executable: `{root}/${JIUWENSWARM_DOCKER_HOME_TARGET}/bin/python`,
    });
    expect(installation.probes[2]?.args[1]).toContain("jiuwenswarm.channels.process_cli.main");
    expect(installation.probes[2]?.args[1]).toContain("jiuwenswarm.channels.process_cli.client");
    expect(installation.probes[2]?.args[1]).toContain("jiuwenswarm.server.runtime.agent_adapter.interface_deep");
    expect(installation.probes[2]?.args[1]).toContain("jiuwenswarm.agents.swarm.assembly");
  });

  it("derives a stable identity that changes with the bundle and the checkout", async () => {
    await fixtureUv();
    process.env.UV_BIN = "uv";
    const checkout = await fakeCheckout();
    process.env.JIUWENSWARM_CHECKOUT = checkout;
    const signal = new AbortController().signal;
    const first = await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal);
    expect((await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).id).toBe(first.id);

    const staged = await mkdtemp(join(tmpdir(), "jiuwenswarm-docker-bundle-"));
    temporary.push(staged);
    await cp(fixtureBundle, staged, { recursive: true });
    await writeFile(join(staged, "config.yaml"), "preferred_language: en\n");
    expect((await jiuwenswarmDockerRuntimeInstallation(staged, signal)).id).not.toBe(first.id);

    await writeFile(join(checkout, "jiuwenswarm", "__init__.py"), "# changed\n");
    expect((await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).id).not.toBe(first.id);
    const changed = await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal);
    await writeFile(join(checkout, sdkWheelName), "changed pinned SDK wheel");
    expect((await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).id).not.toBe(changed.id);

    const inventory = await runtimeInventory(first, "linux/x64", signal);
    expect(inventory.identity).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires JIUWENSWARM_CHECKOUT to be the pinned checkout", async () => {
    process.env.UV_BIN = "uv";
    const signal = new AbortController().signal;
    delete process.env.JIUWENSWARM_CHECKOUT;
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).rejects.toMatchObject({
      name: "JiuwenswarmRuntimeError",
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
    process.env.JIUWENSWARM_CHECKOUT = "relative/checkout";
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).rejects.toMatchObject({
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
    const empty = await mkdtemp(join(tmpdir(), "jiuwenswarm-empty-checkout-"));
    temporary.push(empty);
    process.env.JIUWENSWARM_CHECKOUT = empty;
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal)).rejects.toMatchObject({
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
  });

  it("rejects a missing host uv with ENV_RUNTIME_INSTALL_FAILED", async () => {
    process.env.JIUWENSWARM_CHECKOUT = await fakeCheckout();
    process.env.UV_BIN = join(tmpdir(), "definitely-missing-uv-binary");
    process.env.PATH = "/nonexistent-path-for-test";
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, new AbortController().signal)).rejects.toMatchObject({
      name: "JiuwenswarmRuntimeError",
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
  });

  it.each([undefined, "relative/openjiuwen-0.1.18-py3-none-any.whl", join(tmpdir(), "openjiuwen-0.1.18-cp312-win_amd64.whl"), join(tmpdir(), "openjiuwen-missing-py3-none-any.whl")])(
    "rejects missing or incompatible dependency wheels before image build: %s", async wheel => {
      process.env.JIUWENSWARM_CHECKOUT = await fakeCheckout();
      if (wheel === undefined) delete process.env.JIUWENSWARM_OPENJIUWEN_WHEEL;
      else process.env.JIUWENSWARM_OPENJIUWEN_WHEEL = wheel;
      await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, new AbortController().signal))
        .rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
    },
  );

  it("requires the transitive Git-pinned intelli-router wheel", async () => {
    process.env.JIUWENSWARM_CHECKOUT = await fakeCheckout();
    delete process.env.JIUWENSWARM_INTELLI_ROUTER_WHEEL;
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, new AbortController().signal))
      .rejects.toThrow("JIUWENSWARM_INTELLI_ROUTER_WHEEL");
  });

  it("rejects a non-linux uv binary with ENV_RUNTIME_INSTALL_FAILED", async () => {
    const staging = await mkdtemp(join(tmpdir(), "jiuwenswarm-docker-uv-"));
    temporary.push(staging);
    const fakeUv = join(staging, "uv");
    await writeFile(fakeUv, "#!/bin/sh\necho 'uv 9.9.9'\n");
    await chmod(fakeUv, 0o755);
    process.env.JIUWENSWARM_CHECKOUT = await fakeCheckout();
    process.env.UV_BIN = fakeUv;
    await expect(jiuwenswarmDockerRuntimeInstallation(fixtureBundle, new AbortController().signal)).rejects.toMatchObject({
      name: "JiuwenswarmRuntimeError",
      code: "ENV_RUNTIME_INSTALL_FAILED",
    });
  });
});

describe("jiuwenswarm docker dependency rewrite", () => {
  const rewrite = async (target: string) =>
    await execFileAsync(process.execPath, [jiuwenswarmRewriteRequirements, target, sdkWheelPath, routerWheelPath], { encoding: "utf8" });

  async function writeProject(content: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jiuwenswarm-rewrite-"));
    temporary.push(root);
    const target = join(root, "pyproject.toml");
    await writeFile(target, content);
    return target;
  }

  it("replaces the git-sourced requirement and drops its uv source entry", async () => {
    const target = await writeProject(
      [
        "[project]",
        "dependencies = [",
        `    "${GIT_OPENJIUWEN}",`,
        '    "loguru>=0.7.3,<0.8",',
        "]",
        "",
        "[tool.uv.sources]",
        "workswarm-tui = { path = './packages/jiuwenswarm-tui' }",
        'openjiuwen = { git = "https://gitcode.com/openJiuwen/agent-core.git", rev = "9e3390195a9ea15235b2b5f7412cb2aa440622cc" }',
        "",
      ].join("\n"),
    );
    const { stdout } = await rewrite(target);
    expect(stdout).toContain("rewrote openjiuwen");
    const rewritten = await readFile(target, "utf8");
    expect(rewritten).not.toContain("git+");
    expect(rewritten).not.toContain("openjiuwen = {");
    expect(rewritten).toContain(`"${sdkRequirement}"`);
    expect(await readFile(join(target, "..", "evaluator-overrides.txt"), "utf8"))
      .toBe(`intelli-router @ ${pathToFileURL(routerWheelPath).href}\nfilelock==3.29.0\n`);
    // every other requirement and source entry survives untouched
    expect(rewritten).toContain('"loguru>=0.7.3,<0.8"');
    expect(rewritten).toContain("workswarm-tui = { path = './packages/jiuwenswarm-tui' }");
  });

  it("keeps CRLF checkouts intact and fails when a git requirement survives", async () => {
    const target = await writeProject(
      ["[project]", "dependencies = [", `    "${GIT_OPENJIUWEN}",`, "]"].join("\r\n") + "\r\n",
    );
    await rewrite(target);
    const crlf = await readFile(target, "utf8");
    expect(crlf).toBe(
      ["[project]", "dependencies = [", `    "${sdkRequirement}",`, "]"].join("\r\n") + "\r\n",
    );

    const unfixable = await writeProject(
      ["[project]", "dependencies = [", '    "other @ git+https://example.invalid/other.git",', "]"].join("\n"),
    );
    await expect(rewrite(unfixable)).rejects.toMatchObject({ code: 1 });

    const noPin = await writeProject(["[project]", "dependencies = [", '    "loguru>=0.7.3",', "]"].join("\n"));
    await expect(rewrite(noPin)).rejects.toMatchObject({ code: 1 });
  });
});
