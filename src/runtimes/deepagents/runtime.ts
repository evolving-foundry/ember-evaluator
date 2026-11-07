import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { delimiter } from "node:path";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe, hashRuntimeSource } from "../agentbundle/runtime-files.js";

const execFileAsync = promisify(execFile);

export async function deepagentsBundleRuntimeInstallation(path: string, environment: string | undefined, signal: AbortSignal): Promise<RuntimeInstallation> {
  return environment === "docker" ? deepagentsDockerRuntimeInstallation(path, signal) : deepagentsRuntimeInstallation(signal);
}

export async function deepagentsPythonProvenance(environment: string | undefined, signal: AbortSignal): Promise<string> {
  if (environment === "docker") return "docker uv-managed cpython 3.12 (provisioned in the solver image)";
  const python = await resolveDeepagentsPythonRuntime(signal);
  return `${python.source} ${python.version}`;
}

/** Pinned deepagents release; fresh installs are constrained to it via assets/constraints.txt. */
export const DEEPAGENTS_VERSION = "0.7.15";
export const deepagentsRunner = fileURLToPath(new URL("./assets/runner.py", import.meta.url));
export const deepagentsConstraints = fileURLToPath(new URL("./assets/constraints.txt", import.meta.url));

/** In-image asset layout for the docker solver image (see design/20260929-01). */
export const DEEPAGENTS_DOCKER_BUNDLE_TARGET = "bundle";
export const DEEPAGENTS_DOCKER_HOME_TARGET = "deepagents/home";
export const DEEPAGENTS_DOCKER_UV_TARGET = "uv-bin/uv";

export class DeepagentsRuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "DeepagentsRuntimeError";
  }
}

export type DeepagentsPythonRuntime =
  | { source: "uv"; command: string; version: string }
  | { source: "python"; command: string; version: string };

async function probeVersion(executable: string, args: string[], signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, args, { timeout: 15_000, maxBuffer: 64 * 1024, signal });
    const version = stdout.trim();
    return version === "" ? null : version;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * Resolve the python runtime the AgentBundle CLI will use for venv creation,
 * in the same order as the upstream installer: UV_BIN > PATH uv, then
 * PYTHON_BIN > PATH python3.13/3.12/3.11/3 with the >= 3.11 gate.
 */
export async function resolveDeepagentsPythonRuntime(signal: AbortSignal): Promise<DeepagentsPythonRuntime> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    throw new DeepagentsRuntimeError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "deepagents bundles require a POSIX venv layout; Windows hosts are not supported in this release",
    );
  }
  const uv = await probeVersion(process.env.UV_BIN ?? "uv", ["--version"], signal);
  if (uv !== null) {
    const version = /^uv\s+(\S+)/u.exec(uv)?.[1];
    if (version !== undefined) return { source: "uv", command: process.env.UV_BIN ?? "uv", version };
  }
  const candidates = [process.env.PYTHON_BIN, "python3.13", "python3.12", "python3.11", "python3", "python"].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  for (const candidate of [...new Set(candidates)]) {
    const version = await probeVersion(
      candidate,
      ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
      signal,
    );
    if (version === null) continue;
    const [major, minor] = version.split(".").map(part => Number.parseInt(part, 10));
    if ((major ?? 0) === 3 && (minor ?? 0) >= 11) return { source: "python", command: candidate, version };
  }
  throw new DeepagentsRuntimeError(
    "ENV_RUNTIME_INSTALL_FAILED",
    "deepagents bundles require uv on PATH (preferred) or python >= 3.11; neither was found",
  );
}

export async function deepagentsRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const [runner, constraints, python, agentBundleFiles] = await Promise.all([
    readFile(deepagentsRunner, { signal }),
    readFile(deepagentsConstraints, { encoding: "utf8", signal }),
    resolveDeepagentsPythonRuntime(signal),
    agentBundleRuntimeFiles(),
  ]);
  const pin = constraints.trim();
  if (pin !== `deepagents==${DEEPAGENTS_VERSION}`) {
    throw new DeepagentsRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `constraints.txt must pin deepagents==${DEEPAGENTS_VERSION}`);
  }
  const files = [
    ...agentBundleFiles,
    { source: deepagentsRunner, target: "deepagents/runner.py" },
    { source: deepagentsConstraints, target: "deepagents/constraints.txt" },
  ];
  const pythonProbe =
    python.source === "uv"
      ? { executable: python.command, args: ["--version"] }
      : {
          executable: python.command,
          args: ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
        };
  const commands: RuntimeInstallation["commands"] = [];
  const probes = [agentBundleVersionProbe(), pythonProbe];
  // The installation id covers the exact assets, the resolved python runtime
  // and the probes, so a changed interpreter or runner forces a new bundle
  // home identity instead of reusing an incompatible installation.
  const hash = createHash("sha256")
    .update("deepagents-runtime-1")
    .update(runner)
    .update(constraints)
    .update(python.command)
    .update(python.version);
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  hash.update(canonicalJson({ commands, probes }));
  return { id: `deepagents:${hash.digest("hex")}`, cacheName: `deepagents-${DEEPAGENTS_VERSION}`, files, commands, probes };
}

/**
 * The uv binary is injected into the solver image and executed inside the
 * build, so it must be a linux/x86_64 executable regardless of the host
 * platform (the Docker target is pinned to linux/x64; a static uv build runs
 * on any glibc/musl base).
 */
async function assertLinuxX86_64Binary(path: string, signal: AbortSignal): Promise<void> {
  const handle = await open(path, "r").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new DeepagentsRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `uv binary disappeared: ${path}`);
    throw error;
  });
  try {
    signal.throwIfAborted();
    const { buffer } = await handle.read(Buffer.alloc(20), 0, 20, 0);
    const elf = buffer.subarray(0, 20);
    const isElf =
      elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46 &&
      elf[4] === 2 && elf[5] === 1;
    const machine = (elf[18] ?? 0) | ((elf[19] ?? 0) << 8);
    if (!isElf || machine !== 0x3e)
      throw new DeepagentsRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `the resolved uv binary ${path} is not a linux/x86_64 executable; docker deepagents bundles need a static uv build (e.g. uv-installed x86_64-unknown-linux-gnu/musl), not the host platform binary`,
      );
  } finally {
    await handle.close();
  }
}

async function resolveHostUvBinary(signal: AbortSignal): Promise<{ path: string; version: string }> {
  const candidates = [process.env.UV_BIN, "uv"].filter((value): value is string => value !== undefined && value !== "");
  for (const candidate of [...new Set(candidates)]) {
    const version = await probeVersion(candidate, ["--version"], signal);
    if (version === null) continue;
    let path: string | undefined;
    if (candidate.includes("/")) {
      path = candidate;
    } else {
      // Re-derive the PATH entry the successful probe used so the injected
      // file is the binary that actually executes.
      for (const entry of (process.env.PATH ?? "")
        .split(delimiter)
        .map(item => item.replace(/^"|"$/gu, ""))
        .filter(Boolean)) {
        const full = `${entry}/${candidate}`;
        if ((await probeVersion(full, ["--version"], signal)) !== null) {
          path = full;
          break;
        }
      }
      path ??= candidate;
    }
    await assertLinuxX86_64Binary(path, signal);
    return { path, version: /^uv\s+(\S+)/u.exec(version)?.[1] ?? "unknown" };
  }
  throw new DeepagentsRuntimeError(
    "ENV_RUNTIME_INSTALL_FAILED",
    "docker deepagents bundles require uv on the host (UV_BIN or PATH) to inject the binary into the solver image; install uv or set UV_BIN",
  );
}

/**
 * Runtime installation for the docker solver image: the uv binary, the bundle
 * tree and the CLI assets are baked as files, and the venv is created by
 * build-time commands (uv-managed CPython 3.12, editable install under the
 * constraints pin). The image is the cache unit — one installation maps to one
 * bundle digest, so the home is a fixed path instead of the local per-candidate
 * hashed layout.
 */
export async function deepagentsDockerRuntimeInstallation(
  bundleDir: string,
  signal: AbortSignal,
): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const [runner, constraints, uv, agentBundleFiles] = await Promise.all([
    readFile(deepagentsRunner, { signal }),
    readFile(deepagentsConstraints, { encoding: "utf8", signal }),
    resolveHostUvBinary(signal),
    agentBundleRuntimeFiles(),
  ]);
  const pin = constraints.trim();
  if (pin !== `deepagents==${DEEPAGENTS_VERSION}`) {
    throw new DeepagentsRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `constraints.txt must pin deepagents==${DEEPAGENTS_VERSION}`);
  }
  const home = `{root}/${DEEPAGENTS_DOCKER_HOME_TARGET}`;
  const bundle = `{root}/${DEEPAGENTS_DOCKER_BUNDLE_TARGET}`;
  const uvBin = `{root}/${DEEPAGENTS_DOCKER_UV_TARGET}`;
  const uvPythonDir = "{root}/uv-python";
  const uvCacheDir = "{root}/.uv-cache";
  const uvEnv = {
    UV_PYTHON_INSTALL_DIR: uvPythonDir,
    UV_CACHE_DIR: uvCacheDir,
    // The build container may sit behind a slow egress (no proxy is forwarded
    // into image builds); large wheels exceed uv's 30s default.
    UV_HTTP_TIMEOUT: "300",
  };
  const files = [
    ...agentBundleFiles,
    { source: deepagentsRunner, target: "deepagents/runner.py" },
    { source: deepagentsConstraints, target: "deepagents/constraints.txt" },
    { source: uv.path, target: DEEPAGENTS_DOCKER_UV_TARGET },
    { source: bundleDir, target: DEEPAGENTS_DOCKER_BUNDLE_TARGET },
  ];
  const commands: RuntimeInstallation["commands"] = [
    { executable: uvBin, args: ["venv", "--python", "3.12", home], cwd: ".", env: uvEnv },
    {
      executable: uvBin,
      args: ["pip", "install", "--python", `${home}/bin/python`, "-e", bundle],
      cwd: ".",
      env: { ...uvEnv, UV_CONSTRAINT: "{root}/deepagents/constraints.txt" },
    },
    { executable: uvBin, args: ["cache", "clean"], cwd: ".", env: { UV_CACHE_DIR: uvCacheDir } },
  ];
  const probes: RuntimeInstallation["probes"] = [
    agentBundleVersionProbe(),
    {
      executable: `${home}/bin/python`,
      args: ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
    },
    {
      executable: `${home}/bin/python`,
      args: [
        "-c",
        `from importlib.metadata import version; raise SystemExit(0 if version("deepagents") == ${JSON.stringify(DEEPAGENTS_VERSION)} else 1)`,
      ],
    },
  ];
  const hash = createHash("sha256")
    .update("deepagents-docker-runtime-1")
    .update(runner)
    .update(constraints)
    .update(uv.version);
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  return { id: `deepagents-docker:${hash.digest("hex")}`, cacheName: `deepagents-${DEEPAGENTS_VERSION}`, files, commands, probes };
}
