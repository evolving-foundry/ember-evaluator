import { fetchNetworkResponse } from "../../infrastructure/network/retry.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import type { SolverProvenance } from "../../core/contracts/solver.js";
import { buildFileManifest } from "../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { expectRecord } from "../../core/validation/input.js";
import { DatasetCache } from "../../infrastructure/datasets/cache.js";
import { huggingfaceTransport } from "../../infrastructure/datasets/sources/huggingface/endpoint.js";
import { AGENTX_VERSION } from "./versions.js";

const execFileAsync = promisify(execFile);
export const agentXAssets = fileURLToPath(new URL("./assets/", import.meta.url));

export async function agentXBridgeDigest(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const manifest = await buildFileManifest(agentXAssets, []);
  if (manifest.missing.length) throw new Error("AgentX bridge assets are incomplete");
  return fingerprintConfig(manifest.files);
}

export async function resolveAgentXPython(configured: string | undefined, signal: AbortSignal): Promise<{ executable: string; version: string }> {
  const candidates = configured ? [configured] : [...new Set([process.env.PYTHON_BIN, ...(process.platform === "win32" ? ["python"] : []),
    "python3.13", "python3.12", "python3.11", "python3", "python"].filter((v): v is string => Boolean(v)))];
  for (const executable of candidates) {
    try {
      const { stdout } = await execFileAsync(executable,
        ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], { signal, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      const version = stdout.trim();
      if (/^3\.(?:11|12|13)\.\d+$/u.test(version)) return { executable, version };
    } catch (error) { if (signal.aborted) throw error; }
  }
  throw Object.assign(new Error("AgentX requires Python 3.11–3.13; set solver.config.pythonExecutable or PYTHON_BIN"), { code: "ENV_RUNTIME_INSTALL_FAILED" });
}

export async function agentXLocalInstallation(configured: string | undefined, signal: AbortSignal): Promise<RuntimeInstallation> {
  if (process.platform === "win32" && process.arch === "arm64")
    throw Object.assign(new Error("AgentX public datasets require Linux/WSL or Windows x64"), { code: "ENV_RUNTIME_INSTALL_FAILED" });
  const python = await resolveAgentXPython(configured, signal);
  const rootPython = process.platform === "win32" ? "{root}/venv/Scripts/python.exe" : "{root}/venv/bin/python";
  return { id: `agentx-${AGENTX_VERSION}-${python.version}-${await agentXBridgeDigest(signal)}`,
    cacheName: `agentx-${AGENTX_VERSION}-py${python.version.split(".").slice(0, 2).join(".")}`,
    files: [{ source: agentXAssets, target: "bridge" }], commands: [{ executable: python.executable,
      args: ["{root}/bridge/install.py", "{root}/venv"], env: { PYTHONDONTWRITEBYTECODE: "1" } }],
    probes: [{ executable: rootPython, args: ["-c", `import importlib.metadata as m; assert m.version('agentx-harness') == '${AGENTX_VERSION}'; import evaluator_agentx`] }] };
}

export type AgentXLexicon = { source: string; revision: string; digest: string; path: string };

async function directoryDigest(root: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      signal.throwIfAborted();
      const file = join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new TypeError("AgentX tokenizer snapshots cannot contain links");
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        hash.update(relative(root, file).replaceAll("\\", "/") + "\0");
        for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
        hash.update("\0");
      } else throw new TypeError("Invalid AgentX tokenizer file");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

/** Fetch tokenizer assets only, never model weights; resume uses the original commit. */
export async function lockAgentXLexicon(name: string, revision: string | undefined, cacheDir: string, resolvePath: (path: string) => string,
  signal: AbortSignal, previous?: SolverProvenance, network?: import("../../core/contracts/network.js").NetworkAccess): Promise<AgentXLexicon> {
  const local = resolvePath(name);
  const info = await lstat(local).catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink() || revision !== undefined) throw new TypeError("Local AgentX tokenizer must be a directory without tokenizerRevision");
    const root = await realpath(local), digest = await directoryDigest(root, signal);
    const path = join(cacheDir, "lexicons", digest);
    await mkdir(path, { recursive: true });
    await cp(root, path, { recursive: true, dereference: false });
    if (await directoryDigest(path, signal) !== digest) throw new Error("AgentX tokenizer changed while staging");
    return { source: `local:${digest}`, revision: "local", digest, path };
  }
  if (isAbsolute(name) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name))
    throw new TypeError("AgentX tokenizer must be a Hugging Face org/repo or an existing local directory");
  const transport = huggingfaceTransport(process.env, network);
  const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : undefined;
  const pin = previous?.lexiconRevision ?? revision ?? "main";
  const response = await fetchNetworkResponse(`${transport.apiBase}/api/models/${name}/revision/${encodeURIComponent(pin)}?blobs=true`,
    { signal, ...(headers ? { headers } : {}) }, { ...(network ? { network } : {}) });
  if (!response.ok) throw new Error(`AgentX tokenizer metadata HTTP ${response.status}`);
  const metadata = expectRecord(await response.json(), "AgentX tokenizer metadata");
  if (typeof metadata.sha !== "string" || !/^[a-f0-9]{40}$/u.test(metadata.sha) || !Array.isArray(metadata.siblings))
    throw new TypeError("Invalid AgentX tokenizer revision");
  const files = metadata.siblings.map(value => expectRecord(value, "AgentX tokenizer file")).filter(file =>
    typeof file.rfilename === "string" && (/^(?:config\.json|generation_config\.json|tokenizer[^/]*|special_tokens_map\.json|added_tokens\.json|vocab\.[^/]+|merges\.txt|chat_template\.(?:jinja|json))$/u.test(file.rfilename) || file.rfilename.endsWith(".py")));
  if (!files.length) throw new Error("AgentX tokenizer repository has no tokenizer assets");
  const path = join(cacheDir, "lexicons", fingerprintConfig({ name, revision: metadata.sha }));
  const cache = new DatasetCache(cacheDir, network);
  for (const file of files) {
    const filename = String(file.rfilename);
    if (!/^[A-Za-z0-9_.\/-]+$/u.test(filename) || filename.split("/").some(part => !part || part === "." || part === ".."))
      throw new TypeError("Unsafe AgentX tokenizer asset path");
    const lfs = file.lfs === undefined ? null : expectRecord(file.lfs, "AgentX tokenizer LFS metadata");
    const digest = typeof lfs?.sha256 === "string" ? lfs.sha256 : null;
    const cached = await cache.fetch(`${transport.fileBase}/${name}/resolve/${metadata.sha}/${filename.split("/").map(encodeURIComponent).join("/")}`, digest, signal, headers);
    const target = join(path, ...filename.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await cp(cached.path, target);
  }
  return { source: name, revision: metadata.sha, digest: await directoryDigest(path, signal), path };
}
