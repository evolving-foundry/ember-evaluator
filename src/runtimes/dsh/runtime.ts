import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { maxSatisfying, satisfies, validRange } from "semver";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import type { NetworkAccess } from "../../core/contracts/network.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe, hashRuntimeSource } from "../agentbundle/runtime-files.js";
import { AgentBundleError } from "../agentbundle/cli.js";
import { assertHarnessVersionCompatible } from "../agentbundle/sdk.js";
import { packageManagerCli } from "../../infrastructure/network/package-manager.js";
import { inspectLocalDsh, type LocalDsh } from "./local-runtime.js";

export type DshBundleRuntime = { installation: RuntimeInstallation; version: string; localDsh?: LocalDsh; directory?: string };

export async function describeDshBundleRuntime(
  environment: string | undefined,
  signal: AbortSignal,
  versionRange: string,
  previous?: DshBundleRuntime,
  network?: NetworkAccess,
  lockedVersion?: string,
): Promise<DshBundleRuntime> {
  if (environment === "docker") {
    const version = lockedVersion ?? previous?.version ?? await selectDshVersion(versionRange, async () => {
      const stdout = await npm(["view", "@deepseek-ai/dsh", "versions", "--json"], signal, network);
      const versions: unknown = JSON.parse(stdout);
      if (!Array.isArray(versions) || !versions.every((version): version is string => typeof version === "string"))
        throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "npm returned an invalid DSH version list");
      return versions;
    });
    assertHarnessVersionCompatible(version, versionRange);
    if (previous?.version === version) return previous;
    if (version === DSH_VERSION) return { installation: await dshRuntimeInstallation(signal), version };
    const directory = await mkdtemp(join(tmpdir(), "evaluator-dsh-"));
    try {
      const manifest = JSON.parse(await readFile(dshManifest, { encoding: "utf8", signal }));
      manifest.dependencies["@deepseek-ai/dsh"] = version;
      await writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n", { signal });
      await npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], signal, network, directory);
      return { installation: await dshRuntimeInstallation(signal, version, directory), version, directory };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  if (environment && environment !== "local")
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH reuse supports local or docker environments");
  const localDsh = previous?.localDsh ?? await inspectLocalDsh(process.env, signal);
  const outputHook = dshOutputRuntimeFile();
  const hash = createHash("sha256");
  await hashRuntimeSource(hash, outputHook.source, signal);
  return { localDsh, version: localDsh.version, installation: {
    id: `external-dsh:${JSON.stringify(localDsh)}:${hash.digest("hex")}`,
    cacheName: "dsh-external",
    files: [...await agentBundleRuntimeFiles(), outputHook], commands: [], probes: [agentBundleVersionProbe()],
  } };
}

export const DSH_VERSION = "0.2.2-rc.1";
export const PNPM_VERSION = "11.7.0";
const dshManifest = fileURLToPath(new URL("./assets/package.json", import.meta.url));
const execFileAsync = promisify(execFile);

export async function selectDshVersion(versionRange: string, published: () => Promise<string[]>): Promise<string> {
  const range = validRange(versionRange.replaceAll(",", " "));
  if (range === null)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", `invalid DSH harness version range: ${JSON.stringify(versionRange)}`);
  if (satisfies(DSH_VERSION, range)) return DSH_VERSION;
  const version = maxSatisfying(await published(), range);
  if (version === null)
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", `no published DSH version satisfies ${JSON.stringify(versionRange)}`);
  return version;
}

async function npm(args: string[], signal: AbortSignal, network?: NetworkAccess, cwd?: string): Promise<string> {
  try {
    const registry = network ? ["--registry", network.settings.sources.npm.registry] : [];
    const { stdout } = await execFileAsync(process.execPath, [await packageManagerCli("npm"), ...args, ...registry], {
      cwd, signal, env: network?.environment("runtime", process.env, "host"), timeout: 180_000,
    });
    return stdout;
  } catch (cause) {
    signal.throwIfAborted();
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", `npm ${args[0]} failed while preparing DSH`, { cause });
  }
}
export function dshOutputRuntimeFile(): { source: string; target: string } {
  return { source: fileURLToPath(new URL("./assets/output-hook.mjs", import.meta.url)), target: "dsh-output-hook.mjs" };
}

export async function dshRuntimeInstallation(signal: AbortSignal, version = DSH_VERSION, directory?: string): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const files = [
    { source: directory ? join(directory, "package.json") : dshManifest, target: "package.json" },
    { source: directory ? join(directory, "package-lock.json") : fileURLToPath(new URL("./assets/runtime-lock.json", import.meta.url)), target: "package-lock.json" },
    dshOutputRuntimeFile(),
    ...await agentBundleRuntimeFiles(),
  ];
  const hash = createHash("sha256").update("dsh-runtime-sdk-1");
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  const recipe = {
    files,
    commands: [
      {
        executable: "npm",
        args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        env: {
          NPM_CONFIG_CACHE: "{root}/.npm-cache",
          NPM_CONFIG_USERCONFIG: "{root}/.npmrc",
          NPM_CONFIG_GLOBALCONFIG: "{root}/.npmrc-global",
        },
      },
      { executable: "node", args: ["--eval", "require('node:fs').rmSync('.npm-cache',{recursive:true,force:true})"] },
    ],
    probes: [
      {
        executable: "node",
        args: [
          "--eval",
          `const fs=require('node:fs');for(const [p,v] of ${JSON.stringify([["@deepseek-ai/dsh", version], ["@deepseek-ai/dsh-headless", version], ["pnpm", PNPM_VERSION]])}){if(JSON.parse(fs.readFileSync('node_modules/'+p+'/package.json','utf8')).version!==v)throw Error('runtime version mismatch: '+p)}`,
        ],
      },
      agentBundleVersionProbe(),
    ],
  };
  hash.update(canonicalJson({ commands: recipe.commands, probes: recipe.probes }));
  return { ...recipe, id: `dsh:${hash.digest("hex")}`, cacheName: `dsh-${version}` };
}
