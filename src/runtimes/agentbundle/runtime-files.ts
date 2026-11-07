import type { Hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBundleCoreRoot, AGENT_BUNDLE_CORE_VERSION } from "./sdk.js";

const require = createRequire(import.meta.url);

function packageDirectory(specifier: string): string {
  let dir = dirname(require.resolve(specifier));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (typeof manifest.name === "string") return dir;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate package.json for ${specifier}`);
    dir = parent;
  }
}

export const agentBundleRunner = fileURLToPath(new URL("./assets/run.mjs", import.meta.url));

export type RuntimeFile = { source: string; target: string };

/** Real files only. The runtime scanner rejects symlinks, including pnpm links. */
export async function agentBundleRuntimeFiles(): Promise<RuntimeFile[]> {
  const core = await realpath(agentBundleCoreRoot);
  const entry = await realpath(require.resolve("agent-bundle-core"));
  const outputDirectory = relative(core, dirname(entry));
  if (!outputDirectory || isAbsolute(outputDirectory) || outputDirectory === ".." || outputDirectory.startsWith(`..${sep}`))
    throw new Error("agent-bundle-core entry must be inside its package output directory");
  const yaml = await realpath(packageDirectory("yaml"));
  const semver = await realpath(packageDirectory("semver"));
  return [
    { source: agentBundleRunner, target: "agentbundle/run.mjs" },
    { source: join(core, "package.json"), target: "agentbundle/node_modules/agent-bundle-core/package.json" },
    { source: dirname(entry), target: `agentbundle/node_modules/agent-bundle-core/${outputDirectory.split(sep).join("/")}` },
    { source: yaml, target: "agentbundle/node_modules/yaml" },
    { source: semver, target: "agentbundle/node_modules/semver" },
  ];
}

export function agentBundleVersionProbe(): { executable: string; args: string[] } {
  return {
    executable: "node",
    args: [
      "--eval",
      `const {spawnSync}=require('node:child_process');const result=spawnSync(process.execPath,[process.argv[1],'--version'],{encoding:'utf8'});if(result.status!==0||result.signal||result.stdout.trim()!==${JSON.stringify(AGENT_BUNDLE_CORE_VERSION)})throw Error('agent-bundle-core version mismatch: '+(result.stderr||result.stdout));`,
      "{root}/agentbundle/run.mjs",
    ],
  };
}

export async function hashRuntimeSource(hash: Hash, source: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`agentbundle runtime asset contains a symlink: ${source}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(source)).sort()) {
      hash.update(name);
      await hashRuntimeSource(hash, join(source, name), signal);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`agentbundle runtime asset is not a file: ${source}`);
  hash.update(await readFile(source, { signal }));
}
