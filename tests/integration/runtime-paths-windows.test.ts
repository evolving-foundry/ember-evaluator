import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { RuntimeInstallation } from "../../src/core/contracts/environment.js";
import { prepareLocalRuntime } from "../../src/infrastructure/runtime-installation/install.js";

let python: string | undefined;
if (process.platform === "win32") {
  try {
    python = execFileSync(process.env.PYTHON_BIN ?? "python", ["-c", "import sys, venv; print(sys.executable)"], {
      encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { /* Real Python/venv is optional on test hosts. */ }
}

test.skipIf(!python)("installs deep Python package paths and runs its console entry point at the final Windows location", async () => {
  if (!python) throw new Error("Python was not detected");
  await mkdir(resolve(".scratch"), { recursive: true });
  const temporary = await mkdtemp(resolve(".scratch/rt-win-"));
  const root = await realpath(temporary);
  const cache = join(root, "cache");
  const signal = AbortSignal.timeout(90_000);
  const installer = fileURLToPath(new URL("../fixtures/runtime-paths/install.py", import.meta.url));
  const installation: RuntimeInstallation = {
    id: "python-path-probe-v1", cacheName: "python-path-probe",
    files: [{ source: installer, target: "install.py" }],
    commands: [{ executable: python, args: ["{root}/install.py", "{root}"] }],
    probes: [{ executable: "{root}/venv/Scripts/path-probe.exe", args: [] }],
  };
  try {
    const location = await prepareLocalRuntime(installation, cache, signal);
    const suffix = join("venv", "Lib", "site-packages", "evaluator_path_probe", ...Array<string>(4).fill("nested_dependency"), "payload.txt");
    const installedFile = join(location.root, suffix);
    const previousPath = join(cache, `.${location.identity}-${"0".repeat(36)}.tmp`, suffix);
    expect(previousPath.length).toBeGreaterThan(260);
    expect(installedFile.length).toBeLessThan(260);
    expect(await readFile(installedFile, "utf8")).toBe("installed at final path");
    expect(await prepareLocalRuntime(installation, cache, signal)).toEqual(location);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 100_000);
