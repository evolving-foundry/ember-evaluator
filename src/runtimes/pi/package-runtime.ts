import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { loadBuiltinRuntimeDigest } from "../../infrastructure/provenance/builtin-runtime.js";
import type { StagedPiBundle } from "./bundle.js";

export type PiRuntimePackage = {
  root: string;
  runner: string;
  dispose(): Promise<void>;
};

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

const probe = String.raw`import { accessSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
(async () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const dependency = "@earendil-works/pi-coding-agent";
  const expected = manifest.dependencies?.[dependency];
  if (typeof expected !== "string" || expected.length === 0) throw new Error("Pi SDK dependency is missing from package.json");
  // The pinned Pi entry is dist/index.js. Resolve it with the same ESM import
  // conditions as the runner, including dependencies hoisted above this package.
  const installed = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve(dependency)), "utf8"));
  if (installed.version !== expected) throw new Error("Pi SDK version mismatch: expected " + expected + ", received " + installed.version);
  const runner = resolve("dist", "runtimes", "pi", "runner.js");
  accessSync(runner);
  await import(pathToFileURL(runner).href);
})().catch(error => { console.error(error); process.exitCode = 1; });`;

/**
 * Compose the pi runtime installation. A staged bundle adds its files under
 * `bundle/` plus the Python dependencies the bundle's bridge needs; because
 * those files do not exist inside the repository, bundle mode cannot use the
 * project itself as the local runtime root and always goes through the managed
 * cache (local) or the image layer (Docker).
 */
export async function createPiRuntimeInstallation(signal: AbortSignal, bundle?: StagedPiBundle): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const project = repositoryRoot();
  const compiled = join(project, "dist", "runtimes", "pi");
  try {
    await access(join(compiled, "runner.js"));
  } catch (error) {
    throw new Error("pi runner is not built; run pnpm build before starting simpleagent", { cause: error });
  }
  const id = await loadBuiltinRuntimeDigest();
  const cacheName = `pi-node${process.versions.node.split(".")[0]}`;
  signal.throwIfAborted();
  const files = [
    { source: join(compiled, "runtime-package.json"), target: "package.json" },
    { source: join(compiled, "runtime-lock.json"), target: "package-lock.json" },
    { source: compiled, target: "dist/runtimes/pi" },
  ];
  const commands: RuntimeInstallation["commands"] = [
    {
      executable: "npm",
      args: [
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=verbose",
        "--logs-dir={root}/.npm-logs",
        "--logs-max=1",
      ],
    },
  ];
  const probes: RuntimeInstallation["probes"] = [{ executable: "node", args: ["--input-type=module", "--eval", probe] }];
  if (bundle) {
    files.push({ source: join(bundle.root, "bundle"), target: "bundle" });
    if (bundle.pythonPackages.length > 0) {
      commands.push({
        executable: "python3",
        args: ["-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", ...bundle.pythonPackages],
      });
      probes.push(bundle.pythonRequiredModules.length > 0
        ? { executable: "python3", args: ["-c", `import ${bundle.pythonRequiredModules.join(", ")}`] }
        : { executable: "python3", args: ["--version"] });
    }
    return { id, cacheName, files, commands, probes };
  }
  return { id, cacheName, files, commands, probes, localRoot: project };
}

export async function createPiRuntimePackage(): Promise<PiRuntimePackage> {
  const project = repositoryRoot();
  const compiled = join(project, "dist", "runtimes", "pi");
  const runner = join(compiled, "runner.js");
  try {
    await access(runner);
  } catch (error) {
    throw new Error("pi runner is not built; run pnpm build before starting simpleagent", { cause: error });
  }
  const root = await mkdtemp(join(tmpdir(), "evaluator-pi-runtime-"));
  try {
    const target = join(root, "dist", "runtimes", "pi");
    await mkdir(target, { recursive: true });
    await Promise.all([
      cp(join(compiled, "runtime-package.json"), join(root, "package.json")),
      cp(join(compiled, "runtime-lock.json"), join(root, "package-lock.json")),
      cp(compiled, target, { recursive: true }),
    ]);
    return {
      root,
      runner,
      async dispose() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
