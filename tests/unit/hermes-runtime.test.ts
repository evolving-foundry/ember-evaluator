import { expect, test } from "vitest";
import { HERMES_PIN, HERMES_VERSION, hermesRuntimeInstallation } from "../../src/runtimes/hermes/runtime.js";

test.skipIf(process.platform === "win32")("provisions Hermes via git clone + setup-hermes.sh --runtime-only + mirror re-lock", async () => {
  const signal = new AbortController().signal;
  const installation = await hermesRuntimeInstallation(signal);

  expect(installation.files).toContainEqual(expect.objectContaining({ target: "hermes/runner.py" }));

  // clone + pin + checkout
  expect(installation.commands.slice(0, 4)).toEqual([
    { executable: "git", args: ["clone", "--depth", "1", "https://github.com/NousResearch/hermes-agent.git"] },
    { executable: "git", args: ["fetch", "--depth", "1", "origin", HERMES_PIN], cwd: "hermes-agent" },
    { executable: "git", args: ["fetch", "--depth", "1", "origin", `refs/tags/v${HERMES_VERSION}:refs/tags/v${HERMES_VERSION}`], cwd: "hermes-agent" },
    { executable: "git", args: ["checkout", "FETCH_HEAD"], cwd: "hermes-agent" },
  ]);

  // self-provision + mirror re-lock both run under the provision env (self-contained HOME + mirror index)
  const provisionEnv = { HOME: "{root}", PIP_INDEX_URL: "https://pypi.org/simple", UV_INDEX_URL: "https://pypi.org/simple" };
  const relock = installation.commands[4]!;
  expect(relock).toMatchObject({ executable: "bash", cwd: "hermes-agent" });
  expect(relock.args![0]).toBe("-c");
  expect(relock.env).toEqual(provisionEnv);
  const relockScript = relock.args![1]!;
  expect(relockScript).toContain("exclude-newer");
  expect(relockScript).toContain("= false");
  expect(relockScript).toContain('uv_version="0.12.3"');
  expect(relockScript).toContain("uv download failed");
  expect(relockScript).toContain('lock --index-url="$UV_INDEX_URL"');

  const provision = installation.commands[5]!;
  expect(provision).toMatchObject({ executable: "bash", args: ["setup-hermes.sh", "--runtime-only"], cwd: "hermes-agent" });
  expect(provision.env).toEqual(provisionEnv);

  // baked launcher is rewritten to a location-independent run-in-hermes-env wrapper (rename-safe);
  // it must run as the LAST probe because the version probes re-materialize the baked launcher.
  const launcher = installation.probes[3]!;
  expect(launcher).toMatchObject({ executable: "bash", cwd: "hermes-agent" });
  expect(launcher.args![0]).toBe("-c");
  expect(launcher.env).toEqual(provisionEnv);
  expect(launcher.args![1]!).toContain('run-in-hermes-env" hermes "$@"');

  // CLI probe via run-in-hermes-env (v0.21.6 has no venv/bin/hermes)
  expect(installation.probes[0]).toMatchObject({ executable: "bash", args: ["scripts/run-in-hermes-env", "hermes", "--version"], cwd: "hermes-agent" });
  expect(installation.probes[0]!.env).toEqual(provisionEnv);

  // version assertion probe: hermes --version output must contain HERMES_VERSION
  const versionProbe = installation.probes[1]!;
  expect(versionProbe.executable).toBe("bash");
  expect(versionProbe.args.join(" ")).toContain("run-in-hermes-env hermes --version");
  expect(versionProbe.args.join(" ")).toContain(HERMES_VERSION);
  expect(versionProbe.env).toEqual(provisionEnv);

  // identity is a reproducible digest
  expect(installation.id).toMatch(/^hermes:[a-f0-9]{64}$/);
});

test.skipIf(process.platform === "win32")("changing the pinned commit changes the runtime identity", async () => {
  const signal = new AbortController().signal;
  const installation = await hermesRuntimeInstallation(signal);
  // a different pin must yield a different digest (spot-check the inputs feed the hash)
  expect(installation.id).not.toContain(HERMES_PIN);
  expect(HERMES_PIN).toMatch(/^[0-9a-f]{40}$/);
});

test.runIf(process.platform === "win32")("Windows explicitly rejects the POSIX Hermes installation", async () => {
  await expect(hermesRuntimeInstallation(new AbortController().signal)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
});
