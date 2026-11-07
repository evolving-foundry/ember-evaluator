import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createPiRuntimeInstallation } from "../../src/runtimes/pi/package-runtime.js";

const exec = promisify(execFile);

test.each([
  { layout: "nested", version: "1.1.0" },
  { layout: "hoisted", version: "1.1.0" },
  { layout: "hoisted", version: "9.0.0" },
])("Pi probe resolves $layout dependencies and checks version $version", async ({ layout, version }) => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-probe-"));
  try {
    const packageRoot = join(root, "node_modules", "ember-evaluator");
    const piRoot = join(layout === "nested" ? packageRoot : root, "node_modules", "@earendil-works", "pi-coding-agent");
    const runnerRoot = join(packageRoot, "dist", "runtimes", "pi");
    await mkdir(join(piRoot, "dist"), { recursive: true });
    await mkdir(runnerRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ type: "module",
      dependencies: { "@earendil-works/pi-coding-agent": "1.1.0" } }));
    await writeFile(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent",
      version, type: "module", exports: { ".": { import: "./dist/index.js" } } }));
    await writeFile(join(piRoot, "dist", "index.js"), "export const ready = true;\n");
    await writeFile(join(runnerRoot, "runner.js"),
      'import { ready } from "@earendil-works/pi-coding-agent"; if (!ready) throw new Error("Pi is not ready");\n');
    const installation = await createPiRuntimeInstallation(new AbortController().signal);
    const probe = installation.probes[0];
    if (!probe) throw new Error("Pi probe is missing");
    const checking = exec(process.execPath, probe.args, { cwd: packageRoot });
    if (version === "1.1.0") await expect(checking).resolves.toMatchObject({ stderr: "" });
    else await expect(checking).rejects.toMatchObject({ stderr: expect.stringContaining("Pi SDK version mismatch") });
  } finally { await rm(root, { recursive: true, force: true }); }
});
